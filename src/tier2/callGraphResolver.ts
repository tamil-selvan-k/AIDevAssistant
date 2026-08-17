import { Project, Node, SyntaxKind } from 'ts-morph';
import { ParsedFunction } from '../tier1/astParser';
import { parseJavaFile } from '../tier1/javaAdapter';

export interface CalleeFunction {
  name: string;
  filePath: string;
  text: string;
}

const MAX_DEPTH = 3;
const MAX_CALLEES = 8;

// JS keywords and built-ins to skip when extracting call names
const SKIP_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'function', 'class', 'new', 'return', 'throw',
  'typeof', 'instanceof', 'await', 'async', 'catch', 'try', 'const', 'let', 'var',
  'import', 'export', 'from', 'console', 'Math', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Date', 'Promise', 'JSON', 'Error', 'Map', 'Set',
  'push', 'pop', 'filter', 'map', 'reduce', 'forEach', 'find', 'includes',
  'indexOf', 'split', 'join', 'toString', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'log', 'warn', 'error', 'info', 'keys', 'values', 'entries', 'assign', 'create',
  'stringify', 'parse', 'resolve', 'reject', 'all', 'race', 'then', 'catch', 'finally',
  'get', 'set', 'has', 'delete', 'size', 'length', 'call', 'apply', 'bind',
  'slice', 'splice', 'concat', 'sort', 'reverse', 'flat', 'flatMap', 'some', 'every',
]);

/**
 * Resolve callee functions for a TS/JS function using ts-morph.
 * Builds an in-memory project with all provided source files, extracts a
 * name→function map, then walks the root function's call expressions
 * recursively to collect helper bodies (depth-limited, count-limited).
 */
export function resolveTSCallees(
  fn: ParsedFunction,
  filePath: string,
  sourceText: string,
  allFiles: Array<{ filePath: string; text: string }>
): CalleeFunction[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, skipLibCheck: true },
  });

  // Load the current file and all open workspace files into one project
  const allSources = [{ filePath, text: sourceText }, ...allFiles];
  for (const { filePath: fp, text } of allSources) {
    try { project.createSourceFile(fp, text); } catch { /* skip duplicate paths */ }
  }

  // Build name → callee map from all loaded source files
  const fnMap = new Map<string, CalleeFunction>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();

    sf.getFunctions().forEach(f => {
      const name = f.getName();
      if (name && !fnMap.has(name)) {
        fnMap.set(name, { name, filePath: fp, text: f.getText() });
      }
    });

    sf.getClasses().forEach(cls => {
      cls.getMethods().forEach(m => {
        const name = m.getName();
        if (!fnMap.has(name)) {
          fnMap.set(name, { name, filePath: fp, text: m.getText() });
        }
      });
    });

    sf.getVariableDeclarations().forEach(decl => {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const name = decl.getName();
        if (!fnMap.has(name)) {
          fnMap.set(name, { name, filePath: fp, text: init.getText() });
        }
      }
    });
  }

  const callees: CalleeFunction[] = [];
  const visited = new Set<string>([fn.name]);
  collectCalleesFromText(fn.text, fnMap, visited, callees, 1);
  return callees;
}

/**
 * Resolve callee methods for a Java function within the same source file.
 * java-parser has no type resolution, so cross-file lookup is not feasible locally.
 */
export function resolveJavaCallees(
  fn: ParsedFunction,
  sourceText: string
): CalleeFunction[] {
  const { functions: allMethods } = parseJavaFile('_resolver_temp.java', sourceText);

  // Extract method call names from fn.text: lowercase identifier immediately before '('
  const callPattern = /\b([a-z][a-zA-Z0-9_]*)\s*\(/g;
  const calledNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(fn.text)) !== null) {
    calledNames.add(m[1]);
  }

  const result: CalleeFunction[] = [];
  const visited = new Set<string>([fn.name]);

  for (const method of allMethods) {
    // Strip class prefix (e.g. "MyClass.compute" → "compute") for matching
    const simpleName = method.name.includes('.') ? method.name.split('.').pop()! : method.name;
    if (!visited.has(simpleName) && calledNames.has(simpleName)) {
      visited.add(simpleName);
      result.push({ name: method.name, filePath: '', text: method.text });
      if (result.length >= MAX_CALLEES) { break; }
    }
  }
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function extractCalledNames(fnText: string): string[] {
  const names = new Set<string>();

  // Use ts-morph to reliably extract call expression targets from the snippet
  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true },
    });
    const sf = project.createSourceFile('_snippet.ts', fnText);

    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const expr = call.getExpression();
      if (Node.isIdentifier(expr)) {
        names.add(expr.getText());
      } else if (Node.isPropertyAccessExpression(expr)) {
        names.add(expr.getName()); // method name only (skip the object)
      }
    });
  } catch {
    // Fallback: simple regex if ts-morph can't parse the snippet
    const re = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(fnText)) !== null) { names.add(mm[1]); }
  }

  return [...names].filter(n => !SKIP_NAMES.has(n));
}

function collectCalleesFromText(
  fnText: string,
  fnMap: Map<string, CalleeFunction>,
  visited: Set<string>,
  callees: CalleeFunction[],
  depth: number
): void {
  if (depth > MAX_DEPTH || callees.length >= MAX_CALLEES) { return; }

  const calledNames = extractCalledNames(fnText);

  for (const name of calledNames) {
    if (visited.has(name) || callees.length >= MAX_CALLEES) { continue; }
    const callee = fnMap.get(name);
    if (!callee) { continue; }

    visited.add(name);
    callees.push(callee);
    // Recurse into the callee's body to catch indirect helpers
    collectCalleesFromText(callee.text, fnMap, visited, callees, depth + 1);
  }
}
