import { Project, Node, SyntaxKind, SourceFile } from 'ts-morph';
import { ParsedFunction } from './astParser';

export interface RuleViolation {
  line: number;
  endLine: number;
  message: string;
  severity: 'error' | 'warning';
  ruleId: string;
  suggestedFix: string;
}

// Shared Project singleton — avoids re-initialising the TS language service for every function.
// All Tier-1 rule checks are synchronous (no await) so there is no concurrency conflict.
let _sharedProject: Project | undefined;
const SNIPPET_PATH = '/_snippet_.ts';

function getSnippetSourceFile(text: string): SourceFile {
  if (!_sharedProject) {
    _sharedProject = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  }
  const existing = _sharedProject.getSourceFile(SNIPPET_PATH);
  if (existing) {
    existing.replaceWithText(text);
    return existing;
  }
  return _sharedProject.createSourceFile(SNIPPET_PATH, text);
}

export function runRules(fn: ParsedFunction, _filePath: string): RuleViolation[] {
  const sourceFile = getSnippetSourceFile(fn.text);
  const violations: RuleViolation[] = [];

  // ts-morph line numbers are 1-based; fn.startLine is 1-based.
  // A node at snippet line S maps to document line (fn.startLine + S - 1).
  // diagnosticMapper does `line - 1` to convert to 0-based, so we emit 1-based here.
  const getLine = (node: Node): number => {
    const snippetLine = sourceFile.getLineAndColumnAtPos(node.getStart()).line; // 1-based
    return fn.startLine + snippetLine - 1; // document 1-based line
  };

  checkNullUndefinedAccess(sourceFile, getLine, violations);
  checkArrayBoundsAccess(sourceFile, getLine, violations);
  checkDivisionByZero(sourceFile, getLine, violations);
  checkUnhandledPromise(sourceFile, getLine, violations);
  checkLooseEquality(sourceFile, getLine, violations);
  checkOffByOneLoops(sourceFile, getLine, violations);
  checkUnvalidatedParams(fn, sourceFile, getLine, violations);
  checkEmptyCatch(sourceFile, getLine, violations);
  checkAsyncNoAwait(fn, sourceFile, getLine, violations);
  checkInfiniteLoop(sourceFile, getLine, violations);
  checkTypeofNull(sourceFile, getLine, violations);
  checkSwitchNoDefault(sourceFile, getLine, violations);
  checkArgumentsInArrow(sourceFile, getLine, violations);
  checkPromiseNoCatch(sourceFile, getLine, violations);

  return violations;
}

function checkNullUndefinedAccess(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(node => {
    const expr = node.getExpression();
    const exprText = expr.getText();

    if (exprText.includes('?.') || exprText.includes('!.')) { return; }
    if (isInsideNullGuard(node)) { return; }

    const propChain = node.getText();
    if (propChain.split('.').length >= 3 && !propChain.includes('?.')) {
      const parts = propChain.split('.');
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `Property chain '${propChain}' may throw if '${parts[parts.length - 2]}' is null/undefined — consider optional chaining (?.)`,
        severity: 'warning',
        ruleId: 'null-access',
        suggestedFix: `Use optional chaining: ${parts.join('?.')}`,
      });
    }
  });
}

// Only treat a binary && / || / ?? as a guard when the suspect node is on the RIGHT side,
// meaning the left side already guards it. A node on the left of && is not protected.
function isInsideNullGuard(node: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isIfStatement(current)) { return true; }
    if (Node.isConditionalExpression(current)) { return true; }
    if (Node.isBinaryExpression(current)) {
      const op = current.getOperatorToken().getText();
      if (op === '&&' || op === '||' || op === '??') {
        // Only safe if the suspect expression is on the right-hand side
        const right = current.getRight();
        if (isAncestorOf(right, node)) { return true; }
        // Left side of && is not guarded — keep walking up
      }
    }
    current = current.getParent();
  }
  return false;
}

function isAncestorOf(ancestor: Node, descendant: Node): boolean {
  let current: Node | undefined = descendant;
  while (current) {
    if (current === ancestor) { return true; }
    current = current.getParent();
  }
  return false;
}

function checkArrayBoundsAccess(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).forEach(node => {
    const argExpr = node.getArgumentExpression();
    if (!argExpr) { return; }
    if (Node.isNumericLiteral(argExpr)) { return; }
    if (isInsideNullGuard(node)) { return; }

    const objText = node.getExpression().getText();
    const indexText = argExpr.getText();

    violations.push({
      line: getLine(node),
      endLine: getLine(node),
      message: `Array/string access '${objText}[${indexText}]' without bounds check — may return undefined`,
      severity: 'warning',
      ruleId: 'array-bounds',
      suggestedFix: `Check '${objText}.length > ${indexText}' or use '${objText}.at(${indexText})'`,
    });
  });
}

function checkDivisionByZero(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(node => {
    const op = node.getOperatorToken().getText();
    if (op !== '/' && op !== '%') { return; }

    const right = node.getRight();
    if (Node.isNumericLiteral(right) && right.getText() !== '0') { return; }
    if (isInsideNullGuard(node)) { return; }

    const rightText = right.getText();
    violations.push({
      line: getLine(node),
      endLine: getLine(node),
      message: `Division/modulo by '${rightText}' — guard against zero before this expression`,
      severity: 'error',
      ruleId: 'division-by-zero',
      suggestedFix: `Add a guard: if (${rightText} === 0) throw new Error('Division by zero')`,
    });
  });
}

function checkUnhandledPromise(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression).forEach(node => {
    // Walk up looking for a try block OR the immediately-enclosing async function boundary.
    // Stop at the first async function boundary we hit — if we found a try before that, it's handled.
    let current: Node | undefined = node.getParent();
    while (current) {
      if (Node.isTryStatement(current)) {
        // This await is covered by a try/catch — not a violation
        return;
      }
      // Hit the boundary of the immediately-enclosing async function without finding a try
      if (
        Node.isFunctionDeclaration(current) ||
        Node.isMethodDeclaration(current) ||
        Node.isFunctionExpression(current) ||
        Node.isArrowFunction(current)
      ) {
        violations.push({
          line: getLine(node),
          endLine: getLine(node),
          message: `await expression without try/catch — unhandled rejection may crash callers`,
          severity: 'warning',
          ruleId: 'unhandled-promise',
          suggestedFix: `Wrap with try/catch or append .catch() to handle rejections`,
        });
        return;
      }
      current = current.getParent();
    }
  });
}

function checkLooseEquality(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(node => {
    const op = node.getOperatorToken().getText();
    if (op !== '==' && op !== '!=') { return; }

    const left = node.getLeft().getText();
    const right = node.getRight().getText();

    violations.push({
      line: getLine(node),
      endLine: getLine(node),
      message: `Loose equality '${op}' between '${left}' and '${right}' — use '${op}=' to avoid implicit type coercion`,
      severity: 'warning',
      ruleId: 'loose-equality',
      suggestedFix: `Replace '${op}' with '${op}='`,
    });
  });
}

function checkOffByOneLoops(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.ForStatement).forEach(node => {
    const condition = node.getCondition();
    if (!condition) { return; }

    const condText = condition.getText();

    if (condText.includes('<=') && condText.includes('.length')) {
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `Off-by-one risk: loop condition '${condText}' uses '<=' with .length — last iteration accesses index out of bounds`,
        severity: 'error',
        ruleId: 'off-by-one',
        suggestedFix: `Change '<=' to '<' in the loop condition`,
      });
    }
  });
}

function checkUnvalidatedParams(
  fn: ParsedFunction,
  sourceFile: SourceFile,
  _getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  if (fn.parameters.length < 2) { return; }

  const paramNames = fn.parameters.map(p => p.split(':')[0].trim().replace(/[?!]/g, ''));

  const hasAnyValidation =
    sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement).length > 0 ||
    sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0;

  if (!hasAnyValidation) {
    // Emit directly at fn.startLine — no fnNode guard needed, we already have the context
    violations.push({
      line: fn.startLine,
      endLine: fn.startLine,
      message: `Function '${fn.name}' accepts ${fn.parameters.length} parameters (${paramNames.join(', ')}) with no input validation`,
      severity: 'warning',
      ruleId: 'unvalidated-params',
      suggestedFix: `Validate parameters at the top of the function (type checks, range checks, null checks)`,
    });
  }
}

function checkEmptyCatch(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause).forEach(node => {
    const block = node.getBlock();
    if (block.getStatements().length === 0) {
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `Empty catch block silently swallows exceptions — errors will go undetected`,
        severity: 'warning',
        ruleId: 'empty-catch',
        suggestedFix: `At minimum log the error: console.error(e) or rethrow with context`,
      });
    }
  });
}

function checkAsyncNoAwait(
  fn: ParsedFunction,
  sourceFile: SourceFile,
  _getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  // Check if the snippet text starts an async function
  const isAsync = /\basync\b/.test(fn.text);
  if (!isAsync) { return; }

  const hasAwait = sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression).length > 0;
  if (hasAwait) { return; }

  // Exclude functions that use new Promise(...) — those are intentionally async without await
  const hasNewPromise = fn.text.includes('new Promise');
  if (hasNewPromise) { return; }

  violations.push({
    line: fn.startLine,
    endLine: fn.startLine,
    message: `Async function '${fn.name}' has no await — the async keyword is unnecessary and may signal a missing await`,
    severity: 'warning',
    ruleId: 'async-no-await',
    suggestedFix: `Either add await before the async call, or remove the async keyword if not needed`,
  });
}

function checkInfiniteLoop(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.WhileStatement).forEach(node => {
    const expr = node.getExpression();
    const exprText = expr.getText().trim();

    // Only flag while(true) / while(1) — other conditions are too noisy
    if (exprText !== 'true' && exprText !== '1') { return; }

    const body = node.getStatement();
    const bodyText = body.getText();

    // If there's a break, return, or throw anywhere in the body the loop can exit
    const hasExit = /\b(break|return|throw)\b/.test(bodyText);
    if (!hasExit) {
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `while(${exprText}) loop has no break, return, or throw — possible infinite loop`,
        severity: 'error',
        ruleId: 'infinite-loop',
        suggestedFix: `Add a break/return condition or replace with a bounded loop`,
      });
    }
  });
}

function checkTypeofNull(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(node => {
    const op = node.getOperatorToken().getText();
    if (op !== '===' && op !== '!==') { return; }

    const left = node.getLeft();
    const right = node.getRight();

    const leftIsTypeof = Node.isTypeOfExpression(left);
    const rightIsNullStr = Node.isStringLiteral(right) && right.getLiteralValue() === 'null';
    const rightIsTypeof = Node.isTypeOfExpression(right);
    const leftIsNullStr = Node.isStringLiteral(left) && left.getLiteralValue() === 'null';

    if ((leftIsTypeof && rightIsNullStr) || (rightIsTypeof && leftIsNullStr)) {
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `'typeof x === "null"' is always false — typeof never returns "null"; use '=== null' instead`,
        severity: 'error',
        ruleId: 'typeof-null',
        suggestedFix: `Replace typeof check with a direct null comparison: x === null`,
      });
    }
  });
}

function checkSwitchNoDefault(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.SwitchStatement).forEach(node => {
    const hasDefault = node.getCaseBlock().getClauses()
      .some(c => Node.isDefaultClause(c));
    if (!hasDefault) {
      violations.push({
        line: getLine(node),
        endLine: getLine(node),
        message: `switch statement has no 'default' clause — unexpected values will silently fall through`,
        severity: 'warning',
        ruleId: 'switch-no-default',
        suggestedFix: `Add 'default: throw new Error(\`Unexpected value: \${expr}\`)' to handle unrecognised cases`,
      });
    }
  });
}

function checkArgumentsInArrow(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction).forEach(arrow => {
    arrow.getDescendantsOfKind(SyntaxKind.Identifier).forEach(id => {
      if (id.getText() !== 'arguments') { return; }
      violations.push({
        line: getLine(id),
        endLine: getLine(id),
        message: `'arguments' is not available in arrow functions — it is always undefined here`,
        severity: 'error',
        ruleId: 'arguments-in-arrow',
        suggestedFix: `Use rest parameters instead: (...args) => { ... }`,
      });
    });
  });
}

function checkPromiseNoCatch(
  sourceFile: SourceFile,
  getLine: (n: Node) => number,
  violations: RuleViolation[]
): void {
  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(node => {
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) { return; }
    if (expr.getName() !== 'then') { return; }

    const parent = node.getParent();

    // Safe: chained with .catch() — parent is PropertyAccessExpression named 'catch'
    if (Node.isPropertyAccessExpression(parent) && parent.getName() === 'catch') { return; }

    // Safe: awaited
    if (Node.isAwaitExpression(parent)) { return; }

    // Safe: result returned to caller (caller handles the rejection)
    if (Node.isReturnStatement(parent)) { return; }

    // Safe: result assigned to a variable or passed as argument
    if (Node.isVariableDeclaration(parent)) { return; }
    if (Node.isCallExpression(parent)) { return; }
    if (Node.isBinaryExpression(parent)) { return; }

    violations.push({
      line: getLine(node),
      endLine: getLine(node),
      message: `Promise .then() without .catch() — rejected promise will silently fail`,
      severity: 'warning',
      ruleId: 'promise-no-catch',
      suggestedFix: `Chain .catch(err => console.error(err)) or wrap the caller with try/catch + await`,
    });
  });
}
