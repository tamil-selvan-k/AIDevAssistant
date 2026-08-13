import { ParsedFunction, ASTParseResult, parseFile as parseTS } from './astParser';
import { parseJavaFile } from './javaAdapter';
import { runRules as runTSRules } from './ruleEngine';
import { runJavaRules } from './javaRuleEngine';
import { RuleViolation } from './ruleEngine';

const TS_LANGUAGES = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
const JAVA_LANGUAGES = new Set(['java']);

export function isSupportedLanguage(languageId: string): boolean {
  return TS_LANGUAGES.has(languageId) || JAVA_LANGUAGES.has(languageId);
}

export function parseByLanguage(languageId: string, filePath: string, sourceText: string): ASTParseResult {
  if (JAVA_LANGUAGES.has(languageId)) {
    return parseJavaFile(filePath, sourceText);
  }
  return parseTS(filePath, sourceText);
}

export function runRulesByLanguage(languageId: string, fn: ParsedFunction, filePath: string): RuleViolation[] {
  if (JAVA_LANGUAGES.has(languageId)) {
    return runJavaRules(fn);
  }
  return runTSRules(fn, filePath);
}
