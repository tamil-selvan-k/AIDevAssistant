import * as vscode from 'vscode';
import { diffFunctions, ParsedFunction } from './tier1/astParser';
import { mapRuleViolationsToDiagnostics, mapLLMIssuesToDiagnostics } from './tier1/diagnosticMapper';
import { isSupportedLanguage, parseByLanguage, runRulesByLanguage } from './tier1/languageAdapter';
import { isInteresting } from './tier2/interestFilter';
import { buildContext } from './tier2/contextBuilder';
import { buildPrompt } from './tier2/promptTemplate';
import * as hashCache from './tier2/hashCache';
import { callWithFallback } from './tier2/orchestrator';
import { registerChatParticipant } from './chat/chatParticipant';

const prevFunctionMap = new Map<string, ParsedFunction[]>();
const llmDiagnosticsByHash = new Map<string, Map<string, vscode.Diagnostic[]>>();

export let out: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel('AI Dev Assistant');
  context.subscriptions.push(out);
  out.show(true); // open Output panel on activation

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-dev-assistant');
  context.subscriptions.push(diagnosticCollection);

  // Inject API keys from VS Code settings into process.env (env vars take precedence)
  const cfg = vscode.workspace.getConfiguration('aiDevAssistant');
  if (!process.env.GROQ_API_KEY) {
    const k = cfg.get<string>('groqApiKey');
    if (k) { process.env.GROQ_API_KEY = k; }
  }
  if (!process.env.OPENROUTER_API_KEY) {
    const k = cfg.get<string>('openRouterApiKey');
    if (k) { process.env.OPENROUTER_API_KEY = k; }
  }
  if (!process.env.GEMINI_API_KEY) {
    const k = cfg.get<string>('geminiApiKey');
    if (k) { process.env.GEMINI_API_KEY = k; }
  }

  out.appendLine('AI Dev Assistant activated');
  out.appendLine(`  GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'SET (' + process.env.GROQ_API_KEY.slice(0, 6) + '…)' : 'NOT SET'}`);
  out.appendLine(`  OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? 'SET' : 'NOT SET'}`);
  out.appendLine(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (isSupportedLanguage(doc.languageId)) {
        analyzeDocument(doc, diagnosticCollection).catch(err =>
          console.error('[AI Dev Assistant] analyzeDocument error:', err)
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (isSupportedLanguage(doc.languageId)) {
        analyzeDocument(doc, diagnosticCollection).catch(err =>
          console.error('[AI Dev Assistant] analyzeDocument error:', err)
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDevAssistant.analyzeFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isSupportedLanguage(editor.document.languageId)) {
        vscode.window.showWarningMessage('AI Dev Assistant: Open a JS/TS or Java file to analyze.');
        return;
      }
      await analyzeDocument(editor.document, diagnosticCollection);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDevAssistant.clearCache', () => {
      hashCache.clear();
      prevFunctionMap.clear();
      llmDiagnosticsByHash.clear();
      diagnosticCollection.clear();
      vscode.window.showInformationMessage('AI Dev Assistant: Cache and diagnostics cleared.');
    })
  );

  registerChatParticipant(context);

  for (const doc of vscode.workspace.textDocuments) {
    if (isSupportedLanguage(doc.languageId)) {
      analyzeDocument(doc, diagnosticCollection).catch(console.error);
    }
  }
}

async function analyzeDocument(
  doc: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
  const label = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
  const sourceText = doc.getText();
  if (!sourceText.trim()) { return; }

  const parseResult = parseByLanguage(doc.languageId, doc.fileName, sourceText);
  out.appendLine(`\n[${label}] parsed ${parseResult.functions.length} function(s): ${parseResult.functions.map(f => f.name).join(', ')}`);

  const prev = prevFunctionMap.get(doc.fileName) ?? [];
  const changed = diffFunctions(prev, parseResult.functions);
  prevFunctionMap.set(doc.fileName, parseResult.functions);
  out.appendLine(`[${label}] changed: ${changed.length} (${changed.map(f => f.name).join(', ') || 'none'})`);

  // ── Tier-1: recompute for ALL current functions so stale/deleted fns are dropped ──
  const tier1Diagnostics: vscode.Diagnostic[] = [];
  for (const fn of parseResult.functions) {
    const violations = runRulesByLanguage(doc.languageId, fn, doc.fileName);
    tier1Diagnostics.push(...mapRuleViolationsToDiagnostics(violations, doc));
  }
  out.appendLine(`[${label}] Tier-1: ${tier1Diagnostics.length} diagnostic(s)`);

  // ── LLM store: prune diagnostics for deleted functions ──
  const fileKey = doc.fileName;
  const currentHashes = new Set(parseResult.functions.map(f => f.hash));
  const llmStore = llmDiagnosticsByHash.get(fileKey) ?? new Map<string, vscode.Diagnostic[]>();
  for (const hash of llmStore.keys()) {
    if (!currentHashes.has(hash)) { llmStore.delete(hash); }
  }
  llmDiagnosticsByHash.set(fileKey, llmStore);

  const publishDiagnostics = () => {
    const allLLM = Array.from(llmStore.values()).flat();
    diagnosticCollection.set(doc.uri, [...tier1Diagnostics, ...allLLM]);
  };

  publishDiagnostics();

  // ── Tier-2: only for changed + interesting functions ──
  if (changed.length === 0) {
    out.appendLine(`[${label}] Tier-2 skipped: no changed functions`);
    return;
  }

  const config = vscode.workspace.getConfiguration('aiDevAssistant');
  if (config.get<boolean>('enableTier2') === false) {
    out.appendLine(`[${label}] Tier-2 skipped: disabled in settings`);
    return;
  }

  const interesting = changed.filter(fn => {
    const result = isInteresting(fn);
    out.appendLine(`[${label}]   ${fn.name}: hasDocstring=${fn.hasDocstring}, interesting=${result}`);
    return result;
  });

  if (interesting.length === 0) {
    out.appendLine(`[${label}] Tier-2 skipped: no interesting functions`);
    return;
  }

  for (const fn of interesting) {
    const cached = hashCache.get(fn.hash);
    if (cached) {
      out.appendLine(`[${label}] Tier-2 cache HIT for '${fn.name}'`);
      llmStore.set(fn.hash, mapLLMIssuesToDiagnostics(cached.issues, doc, fn.startLine));
      publishDiagnostics();
      continue;
    }

    out.appendLine(`[${label}] Tier-2 calling LLM for '${fn.name}'...`);
    const prompt = buildPrompt(buildContext(fn));

    try {
      const result = await callWithFallback(prompt, 5000);
      out.appendLine(`[${label}] Tier-2 LLM returned ${result.issues.length} issue(s) for '${fn.name}' (fnStartLine=${fn.startLine})`);
      for (const iss of result.issues) {
        const abs = fn.startLine + iss.line - 2;
        out.appendLine(`[${label}]   → [${iss.severity}] fnLine=${iss.line} absLine0=${abs} | ${iss.message}`);
      }
      hashCache.set(fn.hash, result);
      const mapped = mapLLMIssuesToDiagnostics(result.issues, doc, fn.startLine);
      out.appendLine(`[${label}]   mapped ${mapped.length} diagnostic(s) (doc.lineCount=${doc.lineCount})`);
      llmStore.set(fn.hash, mapped);
      publishDiagnostics();
    } catch (err) {
      const msg = (err as Error).message;
      out.appendLine(`[${label}] Tier-2 FAILED for '${fn.name}': ${msg}`);
      const action = await vscode.window.showWarningMessage(
        `AI Dev Assistant: Tier-2 unavailable for '${fn.name}' — ${msg}`,
        'Open Settings'
      );
      if (action === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'aiDevAssistant.groqApiKey');
      }
    }
  }
}

export function deactivate(): void {
  prevFunctionMap.clear();
  llmDiagnosticsByHash.clear();
  hashCache.clear();
}
