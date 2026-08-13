import * as vscode from 'vscode';
import { RuleViolation } from './ruleEngine';
import { LLMIssue } from '../providers/llmProvider';

export function mapRuleViolationsToDiagnostics(
  violations: RuleViolation[],
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  return violations.map(v => {
    // v.line is already an absolute 1-based document line — convert to 0-based for VS Code
    const line = Math.max(0, Math.min(v.line - 1, document.lineCount - 1));
    const lineText = document.lineAt(line).text;
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, lineText.length)
    );

    const diagnostic = new vscode.Diagnostic(
      range,
      `[Tier-1] ${v.message}`,
      v.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'AI Dev Assistant';
    diagnostic.code = v.ruleId;

    if (v.suggestedFix) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, range),
          `Suggested fix: ${v.suggestedFix}`
        )
      ];
    }

    return diagnostic;
  });
}

export function mapLLMIssuesToDiagnostics(
  issues: LLMIssue[],
  document: vscode.TextDocument,
  fnStartLine: number  // 1-based absolute line where the function starts in the document
): vscode.Diagnostic[] {
  return issues.map(issue => {
    // issue.line is function-relative (1-based); convert to absolute 0-based for VS Code
    const absoluteLine = fnStartLine + issue.line - 2; // (fnStartLine - 1) + (issue.line - 1)
    const line = Math.max(0, Math.min(absoluteLine, document.lineCount - 1));
    const lineText = document.lineAt(line).text;
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, lineText.length)
    );

    const severityMap: Record<string, vscode.DiagnosticSeverity> = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information,
    };

    const diagnostic = new vscode.Diagnostic(
      range,
      `[Tier-2] ${issue.message}`,
      severityMap[issue.severity] ?? vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'AI Dev Assistant (LLM)';
    diagnostic.code = issue.category;

    if (issue.suggestedFix) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, range),
          `Suggested fix: ${issue.suggestedFix}`
        )
      ];
    }

    return diagnostic;
  });
}
