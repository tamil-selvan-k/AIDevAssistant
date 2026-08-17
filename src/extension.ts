import * as vscode from 'vscode';
import { diffFunctions, ParsedFunction } from './tier1/astParser';
import { mapRuleViolationsToDiagnostics, mapLLMIssuesToDiagnostics } from './tier1/diagnosticMapper';
import { isSupportedLanguage, parseByLanguage, runRulesByLanguage } from './tier1/languageAdapter';
import { isInteresting } from './tier2/interestFilter';
import { buildContext } from './tier2/contextBuilder';
import { buildPrompt } from './tier2/promptTemplate';
import * as hashCache from './tier2/hashCache';
import { callWithFallback, setLogger } from './tier2/orchestrator';
import { registerChatParticipant } from './chat/chatParticipant';

const prevFunctionMap = new Map<string, ParsedFunction[]>();
const llmDiagnosticsByHash = new Map<string, Map<string, vscode.Diagnostic[]>>();

export let out: vscode.OutputChannel;

// All known rule IDs across TS/JS and Java — used by the listRuleIds command.
const ALL_RULE_IDS = [
  // TS/JS
  'null-access', 'array-bounds', 'division-by-zero', 'unhandled-promise',
  'loose-equality', 'off-by-one', 'unvalidated-params', 'empty-catch',
  'async-no-await', 'infinite-loop', 'typeof-null', 'switch-no-default',
  'arguments-in-arrow', 'promise-no-catch',
  // Java
  'java-null-deref', 'java-array-bounds', 'java-division-by-zero',
  'java-unchecked-exception', 'java-string-equals', 'java-off-by-one',
  'java-unvalidated-params', 'java-empty-catch', 'java-resource-leak',
  'java-instanceof-cast', 'java-string-concat-loop',
  'java-broad-catch', 'java-static-mutable-field', 'java-system-exit',
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── SYNCHRONOUS SETUP — must complete before any await ──────────────────────
  // Anything registered here is guaranteed to work even if the async key-loading
  // below fails. VS Code invokes the chat participant handler as soon as activate()
  // resolves, so we register it first.

  out = vscode.window.createOutputChannel('AI Dev Assistant');
  context.subscriptions.push(out);
  out.show(true);

  // Route orchestrator logs to the Output channel so provider failures are visible
  setLogger(msg => out.appendLine(msg));

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-dev-assistant');
  context.subscriptions.push(diagnosticCollection);

  hashCache.initPersistence(context.globalState);

  // Register the chat participant before any await — this is the most common
  // activation path when the user types @devassistant in chat.
  registerChatParticipant(context);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDevAssistant.storeApiKey', async () => {
      const provider = await vscode.window.showQuickPick(
        ['Groq (primary)', 'OpenRouter (fallback 1)', 'Gemini (fallback 2)'],
        { placeHolder: 'Which API key do you want to store securely?' }
      );
      if (!provider) { return; }

      const secretId = provider.startsWith('Groq')
        ? 'aiDevAssistant.groqApiKey'
        : provider.startsWith('OpenRouter')
          ? 'aiDevAssistant.openRouterApiKey'
          : 'aiDevAssistant.geminiApiKey';

      const envVar = provider.startsWith('Groq') ? 'GROQ_API_KEY'
        : provider.startsWith('OpenRouter') ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY';

      const key = await vscode.window.showInputBox({
        prompt: `Paste your ${provider} API key`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) { return; }

      await context.secrets.store(secretId, key);
      process.env[envVar] = key;
      vscode.window.showInformationMessage(`AI Dev Assistant: ${provider} key stored securely.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDevAssistant.listRuleIds', () => {
      out.show(true);
      out.appendLine('\n── Available Rule IDs ──────────────────────────────');
      for (const id of ALL_RULE_IDS) { out.appendLine(`  ${id}`); }
      out.appendLine('Add any of these to aiDevAssistant.disabledRules to suppress them.');
    })
  );

  // Kick off analysis for already-open files (synchronous trigger, async body)
  for (const doc of vscode.workspace.textDocuments) {
    if (isSupportedLanguage(doc.languageId)) {
      analyzeDocument(doc, diagnosticCollection).catch(console.error);
    }
  }

  // ── ASYNC: load API keys — wrapped so any failure never breaks activation ──
  try {
    const cfg = vscode.workspace.getConfiguration('aiDevAssistant');
    const secretKeys: Array<[string, string, string]> = [
      ['aiDevAssistant.groqApiKey',       'GROQ_API_KEY',       'groqApiKey'],
      ['aiDevAssistant.openRouterApiKey', 'OPENROUTER_API_KEY', 'openRouterApiKey'],
      ['aiDevAssistant.geminiApiKey',     'GEMINI_API_KEY',     'geminiApiKey'],
    ];
    for (const [secretId, envVar, settingKey] of secretKeys) {
      if (process.env[envVar]) { continue; }
      const fromSecret = await context.secrets.get(secretId);
      const fromSetting = cfg.get<string>(settingKey);
      const key = fromSecret || fromSetting;
      if (key) { process.env[envVar] = key; }
    }
  } catch (err) {
    out.appendLine(`[Warning] Secure key storage unavailable: ${(err as Error).message}. Falling back to settings.`);
    const cfg = vscode.workspace.getConfiguration('aiDevAssistant');
    if (!process.env.GROQ_API_KEY)       { const k = cfg.get<string>('groqApiKey');       if (k) { process.env.GROQ_API_KEY = k; } }
    if (!process.env.OPENROUTER_API_KEY) { const k = cfg.get<string>('openRouterApiKey'); if (k) { process.env.OPENROUTER_API_KEY = k; } }
    if (!process.env.GEMINI_API_KEY)     { const k = cfg.get<string>('geminiApiKey');     if (k) { process.env.GEMINI_API_KEY = k; } }
  }

  out.appendLine('AI Dev Assistant activated');
  out.appendLine(`  GROQ_API_KEY:       ${process.env.GROQ_API_KEY        ? 'SET (' + process.env.GROQ_API_KEY.slice(0, 6) + '…)' : 'NOT SET'}`);
  out.appendLine(`  OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY  ? 'SET' : 'NOT SET'}`);
  out.appendLine(`  GEMINI_API_KEY:     ${process.env.GEMINI_API_KEY      ? 'SET' : 'NOT SET'}`);
  out.appendLine(`  LLM cache size:     ${hashCache.size()} entry(ies) restored`);
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

  const config = vscode.workspace.getConfiguration('aiDevAssistant');
  const disabledRules = config.get<string[]>('disabledRules') ?? [];

  // ── Tier-1: recompute for ALL current functions so stale/deleted fns are dropped ──
  const tier1Diagnostics: vscode.Diagnostic[] = [];
  const tier1HitsByHash = new Map<string, number>();
  for (const fn of parseResult.functions) {
    const violations = runRulesByLanguage(doc.languageId, fn, doc.fileName)
      .filter(v => !disabledRules.includes(v.ruleId));
    tier1HitsByHash.set(fn.hash, violations.length);
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

  // Cap open files — building a large ts-morph project is expensive
  const maxFiles = config.get<number>('maxContextFiles') ?? 15;
  const openFiles = vscode.workspace.textDocuments
    .filter(d => d.fileName !== doc.fileName && /\.(ts|tsx|js|jsx)$/i.test(d.fileName))
    .slice(0, maxFiles)
    .map(d => ({ filePath: d.fileName, text: d.getText() }));

  for (const fn of interesting) {
    if ((tier1HitsByHash.get(fn.hash) ?? 0) > 0) {
      out.appendLine(`[${label}] Tier-2 skipped for '${fn.name}': Tier-1 already flagged ${tier1HitsByHash.get(fn.hash)} issue(s)`);
      continue;
    }

    const ctx = buildContext(fn, doc.fileName, sourceText, openFiles);
    out.appendLine(`[${label}] Tier-2 context for '${fn.name}': ${ctx.callees.length} callee(s) [${ctx.callees.map(c => c.name).join(', ') || 'none'}]`);

    const cached = hashCache.get(ctx.compositeHash);
    if (cached) {
      out.appendLine(`[${label}] Tier-2 cache HIT for '${fn.name}'`);
      if (cached.analysisNote) {
        out.appendLine(`[${label}]   analysisNote: ${cached.analysisNote}`);
      }
      llmStore.set(fn.hash, mapLLMIssuesToDiagnostics(cached.issues, doc, fn.startLine));
      publishDiagnostics();
      continue;
    }

    out.appendLine(`[${label}] Tier-2 calling LLM for '${fn.name}'...`);
    const prompt = buildPrompt(ctx);

    try {
      const result = await callWithFallback(prompt, 5000);
      out.appendLine(`[${label}] Tier-2 LLM returned ${result.issues.length} issue(s) for '${fn.name}' (fnStartLine=${fn.startLine})`);
      if (result.analysisNote) {
        out.appendLine(`[${label}]   analysisNote: ${result.analysisNote}`);
      }
      for (const iss of result.issues) {
        const abs = fn.startLine + iss.line - 2;
        out.appendLine(`[${label}]   → [${iss.severity}] fnLine=${iss.line} absLine0=${abs} | ${iss.message}`);
      }
      hashCache.set(ctx.compositeHash, result);
      const mapped = mapLLMIssuesToDiagnostics(result.issues, doc, fn.startLine);
      out.appendLine(`[${label}]   mapped ${mapped.length} diagnostic(s) (doc.lineCount=${doc.lineCount})`);
      llmStore.set(fn.hash, mapped);
      publishDiagnostics();
    } catch (err) {
      const msg = (err as Error).message;
      out.appendLine(`[${label}] Tier-2 FAILED for '${fn.name}': ${msg}`);
      const action = await vscode.window.showWarningMessage(
        `AI Dev Assistant: Tier-2 unavailable for '${fn.name}' — ${msg}`,
        'Open Settings',
        'Store API Key'
      );
      if (action === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'aiDevAssistant');
      } else if (action === 'Store API Key') {
        vscode.commands.executeCommand('aiDevAssistant.storeApiKey');
      }
    }
  }
}

export function deactivate(): void {
  prevFunctionMap.clear();
  llmDiagnosticsByHash.clear();
  hashCache.clear();
}
