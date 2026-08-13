import { Project, SourceFile, FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression, Node, SyntaxKind } from 'ts-morph';
import { createHash } from 'crypto';

export interface ParsedFunction {
  name: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  hasDocstring: boolean;
  parameters: string[];
  returnType: string;
}

export interface ASTParseResult {
  functions: ParsedFunction[];
  filePath: string;
}

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

export function parseFile(filePath: string, sourceText: string): ASTParseResult {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sourceFile = project.createSourceFile(filePath, sourceText);
  const functions = extractFunctions(sourceFile);
  return { functions, filePath };
}

function extractFunctions(sourceFile: SourceFile): ParsedFunction[] {
  const results: ParsedFunction[] = [];
  const seen = new Set<string>();

  const addFn = (node: FunctionLike, baseName: string) => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    const text = node.getText();
    const hash = createHash('sha256').update(text).digest('hex');
    const hasDocstring = hasLeadingDocstring(node);
    const parameters = getParameterNames(node);
    const returnType = getReturnType(node);

    // Disambiguate same-named functions (anonymous arrows, overloads) with start line
    const name = seen.has(baseName) ? `${baseName}@${start.line}` : baseName;
    seen.add(baseName);

    results.push({
      name,
      startLine: start.line,
      endLine: end.line,
      text,
      hash,
      hasDocstring,
      parameters,
      returnType,
    });
  };

  sourceFile.getFunctions().forEach(fn => {
    const name = fn.getName() ?? '<anonymous>';
    addFn(fn, name);
  });

  sourceFile.getClasses().forEach(cls => {
    cls.getMethods().forEach(method => {
      const name = `${cls.getName() ?? 'Class'}.${method.getName()}`;
      addFn(method, name);
    });
  });

  sourceFile.getVariableDeclarations().forEach(decl => {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const name = decl.getName();
      addFn(init as ArrowFunction | FunctionExpression, name);
    }
  });

  return results;
}

function hasLeadingDocstring(node: FunctionLike): boolean {
  const jsDocNodes = (node as FunctionDeclaration).getJsDocs?.();
  if (jsDocNodes && jsDocNodes.length > 0) { return true; }

  const leadingTrivia = node.getLeadingCommentRanges();
  return leadingTrivia.length > 0;
}

function getParameterNames(node: FunctionLike): string[] {
  return node.getParameters().map(p => p.getText());
}

function getReturnType(node: FunctionLike): string {
  const returnTypeNode = node.getReturnTypeNode();
  if (returnTypeNode) { return returnTypeNode.getText(); }
  try {
    return node.getReturnType().getText();
  } catch {
    return 'unknown';
  }
}

export function diffFunctions(prev: ParsedFunction[], next: ParsedFunction[]): ParsedFunction[] {
  // Key on (name, startLine) to avoid collisions between same-named functions
  const prevMap = new Map(prev.map(f => [`${f.name}:${f.startLine}`, f.hash]));
  return next.filter(f => prevMap.get(`${f.name}:${f.startLine}`) !== f.hash);
}
