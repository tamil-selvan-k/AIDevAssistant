import * as vscode from 'vscode';
import { isSupportedLanguage, parseByLanguage, runRulesByLanguage } from '../tier1/languageAdapter';
import { isInteresting } from '../tier2/interestFilter';
import { buildContext } from '../tier2/contextBuilder';
import { buildPrompt } from '../tier2/promptTemplate';
import * as hashCache from '../tier2/hashCache';
import { callWithFallback } from '../tier2/orchestrator';
import { LLMIssue } from '../providers/llmProvider';

const PARTICIPANT_ID = 'aiDevAssistant.devassistant';

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handleChatRequest);
  participant.iconPath = new vscode.ThemeIcon('bug');
  context.subscriptions.push(participant);
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  _chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    stream.markdown('No active editor. Open a JS/TS or Java file and ask me about it.');
    return;
  }

  const doc = editor.document;

  if (!isSupportedLanguage(doc.languageId)) {
    stream.markdown('AI Dev Assistant supports JavaScript, TypeScript, and Java files.');
    return;
  }

  stream.markdown('**AI Dev Assistant** analyzing your code...\n\n');

  const userQuery = request.prompt.trim().toLowerCase();
  const isAskAboutSelection = userQuery.includes('this') || userQuery.includes('selected') || userQuery.includes('function') || userQuery.includes('method');
  const selection = editor.selection;

  let codeToAnalyze = '';
  if (!selection.isEmpty && isAskAboutSelection) {
    codeToAnalyze = doc.getText(selection);
  } else {
    codeToAnalyze = doc.getText();
  }

  if (!codeToAnalyze.trim()) {
    stream.markdown('The file appears to be empty.');
    return;
  }

  const parseResult = parseByLanguage(doc.languageId, doc.fileName, codeToAnalyze);

  if (parseResult.functions.length === 0) {
    stream.markdown('No functions/methods found to analyze in the current selection/file.');
    return;
  }

  const langLabel = doc.languageId === 'java' ? 'Java' : 'JS/TS';
  stream.markdown(`Found **${parseResult.functions.length}** ${langLabel} function(s). Running analysis...\n\n`);

  const config = vscode.workspace.getConfiguration('aiDevAssistant');
  const disabledRules = config.get<string[]>('disabledRules') ?? [];
  const maxFiles = config.get<number>('maxContextFiles') ?? 15;

  // Full source text (not just selection) — needed for callee resolution
  const fullSourceText = doc.getText();
  const openFiles = vscode.workspace.textDocuments
    .filter(d => d.fileName !== doc.fileName && /\.(ts|tsx|js|jsx)$/i.test(d.fileName))
    .slice(0, maxFiles)
    .map(d => ({ filePath: d.fileName, text: d.getText() }));

  for (const fn of parseResult.functions) {
    if (token.isCancellationRequested) { break; }

    stream.markdown(`---\n### \`${fn.name}\` (line ${fn.startLine})\n\n`);

    const tier1Violations = runRulesByLanguage(doc.languageId, fn, doc.fileName)
      .filter(v => !disabledRules.includes(v.ruleId));

    if (tier1Violations.length > 0) {
      stream.markdown('**Tier-1 Static Issues:**\n');
      for (const v of tier1Violations) {
        const icon = v.severity === 'error' ? '🔴' : '🟡';
        stream.markdown(`${icon} Line ${v.line}: ${v.message}\n`);
        stream.markdown(`  > Fix: ${v.suggestedFix}\n\n`);
      }
    } else {
      stream.markdown('No Tier-1 static issues found.\n\n');
    }

    if (isInteresting(fn)) {
      stream.markdown('**Tier-2 LLM Analysis** (business logic)...\n\n');

      // Build context (includes callee resolution) to get the compositeHash for cache key
      const ctx = buildContext(fn, doc.fileName, fullSourceText, openFiles);

      const cached = hashCache.get(ctx.compositeHash);
      if (cached) {
        stream.markdown('*(from cache)*\n\n');
        renderLLMIssues(stream, cached.issues);
      } else {
        const prompt = buildPrompt(ctx);
        try {
          const result = await callWithFallback(prompt, 5000);
          hashCache.set(ctx.compositeHash, result);
          renderLLMIssues(stream, result.issues);
        } catch (err) {
          stream.markdown(`> Tier-2 analysis unavailable: ${(err as Error).message}\n\n`);
        }
      }
    } else {
      stream.markdown('*Tier-2 skipped — function lacks business-logic keywords or docstring.*\n\n');
    }
  }

  stream.markdown('\n---\n*AI Dev Assistant — suggest only, no auto-fix applied.*');
}

function renderLLMIssues(stream: vscode.ChatResponseStream, issues: LLMIssue[]): void {
  if (issues.length === 0) {
    stream.markdown('No business-logic issues detected.\n\n');
    return;
  }
  for (const issue of issues) {
    const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warning' ? '🟡' : 'ℹ️';
    stream.markdown(`${icon} **[${issue.category}]** Line ${issue.line}: ${issue.message}\n`);
    stream.markdown(`  > Fix: ${issue.suggestedFix}\n\n`);
  }
}
