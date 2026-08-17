import { createHash } from 'crypto';
import { ParsedFunction } from '../tier1/astParser';
import { resolveTSCallees, resolveJavaCallees, CalleeFunction } from './callGraphResolver';

export interface FunctionContext {
  functionName: string;
  functionCode: string;
  parameters: string[];
  returnType: string;
  docstring: string;
  startLine: number;
  language: 'typescript' | 'java';
  callees: CalleeFunction[];
  /** SHA-256 of root function text + all callee texts — used as the LLM cache key */
  compositeHash: string;
}

/**
 * Build the context sent to the LLM.
 *
 * @param fn          The root function to analyze
 * @param filePath    Absolute path of the containing file (enables callee resolution)
 * @param sourceText  Full source text of the containing file
 * @param allFiles    Other open workspace files (TS/JS only; used for cross-file lookup)
 */
export function buildContext(
  fn: ParsedFunction,
  filePath?: string,
  sourceText?: string,
  allFiles?: Array<{ filePath: string; text: string }>
): FunctionContext {
  const isJava = /\.java$/i.test(filePath ?? '');
  const language: 'typescript' | 'java' = isJava ? 'java' : 'typescript';

  let callees: CalleeFunction[] = [];
  if (filePath && sourceText) {
    try {
      callees = isJava
        ? resolveJavaCallees(fn, sourceText)
        : resolveTSCallees(fn, filePath, sourceText, allFiles ?? []);
    } catch {
      // best-effort — proceed without callee context on any error
    }
  }

  const compositeHash = computeCompositeHash(fn.text, callees);

  return {
    functionName: fn.name,
    functionCode: fn.text,
    parameters: fn.parameters,
    returnType: fn.returnType,
    docstring: extractDocstring(fn.text),
    startLine: fn.startLine,
    language,
    callees,
    compositeHash,
  };
}

function computeCompositeHash(rootText: string, callees: CalleeFunction[]): string {
  const combined = rootText + callees.map(c => c.text).join('');
  return createHash('sha256').update(combined).digest('hex');
}

function extractDocstring(fnText: string): string {
  const jsDocMatch = fnText.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsDocMatch) { return jsDocMatch[0].trim(); }

  const lineCommentMatch = fnText.match(/^(\s*\/\/[^\n]*\n)+/);
  if (lineCommentMatch) { return lineCommentMatch[0].trim(); }

  return '';
}
