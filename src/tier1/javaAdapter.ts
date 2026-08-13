import { createHash } from 'crypto';
import { parse } from 'java-parser';
import { ParsedFunction, ASTParseResult } from './astParser';

export function parseJavaFile(filePath: string, sourceText: string): ASTParseResult {
  const functions: ParsedFunction[] = [];

  try {
    const cst = parse(sourceText);
    extractMethods(cst, sourceText, functions);
  } catch (err) {
    // Parse error — return empty so Tier-1 silently skips rather than crashing
    console.warn(`[AI Dev Assistant] Java parse error in ${filePath}: ${(err as Error).message}`);
  }

  return { functions, filePath };
}

function extractMethods(cst: ReturnType<typeof parse>, sourceText: string, out: ParsedFunction[]): void {
  const lines = sourceText.split('\n');
  const seen = new Set<string>();

  walkNode(cst, (node: CSTNode) => {
    if (node.name !== 'methodDeclaration' && node.name !== 'interfaceMethodDeclaration') { return; }

    const methodName = extractMethodName(node);
    const startLine = getStartLine(node);
    const endLine = getEndLine(node);
    const text = extractText(lines, startLine, endLine);
    const hash = createHash('sha256').update(text).digest('hex');
    const hasDocstring = hasLeadingJavadoc(lines, startLine);
    const parameters = extractParameters(node);
    const returnType = extractReturnType(node);

    // Disambiguate overloads by appending start line
    const baseName = methodName;
    const name = seen.has(baseName) ? `${baseName}@${startLine}` : baseName;
    seen.add(baseName);

    out.push({ name, startLine, endLine, text, hash, hasDocstring, parameters, returnType });
  });
}

interface CSTNode {
  name?: string;
  image?: string;
  startLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
  children?: Record<string, CSTNode[]>;
  location?: { startLine: number; endLine: number; startOffset: number; endOffset: number };
}

function walkNode(node: CSTNode, visitor: (n: CSTNode) => void): void {
  if (!node) { return; }
  visitor(node);
  if (node.children) {
    for (const children of Object.values(node.children)) {
      if (Array.isArray(children)) {
        for (const child of children) {
          walkNode(child, visitor);
        }
      }
    }
  }
}

function extractMethodName(node: CSTNode): string {
  let name = '<unknown>';
  walkNode(node, n => {
    if (n.name === 'methodDeclarator' || n.name === 'methodHeader') {
      if (n.children?.Identifier?.[0]?.image) {
        name = n.children.Identifier[0].image;
      }
    }
    if (n.name === 'Identifier' && name === '<unknown>') {
      name = n.image ?? '<unknown>';
    }
  });
  return name;
}

function getStartLine(node: CSTNode): number {
  return node.location?.startLine ?? 1;
}

function getEndLine(node: CSTNode): number {
  return node.location?.endLine ?? 1;
}

function extractText(lines: string[], startLine: number, endLine: number): string {
  // lines array is 0-indexed; startLine/endLine are 1-indexed
  return lines.slice(startLine - 1, endLine).join('\n');
}

function hasLeadingJavadoc(lines: string[], startLine: number): boolean {
  // Look backwards from method declaration for /** ... */ or // comments
  for (let i = startLine - 2; i >= Math.max(0, startLine - 10); i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { continue; }
    if (trimmed.endsWith('*/') || trimmed.startsWith('*') || trimmed.startsWith('/**')) { return true; }
    if (trimmed.startsWith('//')) { return true; }
    break;
  }
  return false;
}

function extractParameters(node: CSTNode): string[] {
  const params: string[] = [];
  walkNode(node, n => {
    if (n.name === 'formalParameter') {
      // Collect the text of each formalParameter
      const parts: string[] = [];
      walkNode(n, inner => {
        if (inner.image) { parts.push(inner.image); }
      });
      if (parts.length > 0) { params.push(parts.join(' ')); }
    }
  });
  return params;
}

function extractReturnType(node: CSTNode): string {
  let returnType = 'void';
  walkNode(node, n => {
    if (n.name === 'result' || n.name === 'unannType' || n.name === 'unannReferenceType') {
      const parts: string[] = [];
      walkNode(n, inner => {
        if (inner.image) { parts.push(inner.image); }
      });
      if (parts.length > 0) { returnType = parts.join(''); }
    }
  });
  return returnType;
}
