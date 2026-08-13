import { ParsedFunction } from '../tier1/astParser';

export interface FunctionContext {
  functionName: string;
  functionCode: string;
  parameters: string[];
  returnType: string;
  docstring: string;
  startLine: number;
}

export function buildContext(fn: ParsedFunction): FunctionContext {
  return {
    functionName: fn.name,
    functionCode: fn.text,
    parameters: fn.parameters,
    returnType: fn.returnType,
    docstring: extractDocstring(fn.text),
    startLine: fn.startLine,
  };
}

function extractDocstring(fnText: string): string {
  const jsDocMatch = fnText.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsDocMatch) { return jsDocMatch[0].trim(); }

  const lineCommentMatch = fnText.match(/^(\s*\/\/[^\n]*\n)+/);
  if (lineCommentMatch) { return lineCommentMatch[0].trim(); }

  return '';
}
