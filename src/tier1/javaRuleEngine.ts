import { ParsedFunction } from './astParser';
import { RuleViolation } from './ruleEngine';

export function runJavaRules(fn: ParsedFunction): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const lines = fn.text.split('\n');

  checkNullDereference(fn, lines, violations);
  checkArrayIndexOutOfBounds(fn, lines, violations);
  checkDivisionByZero(fn, lines, violations);
  checkUncheckedExceptions(fn, lines, violations);
  checkStringEqualityWithDoubleEquals(fn, lines, violations);
  checkOffByOneLoops(fn, lines, violations);
  checkUnvalidatedParams(fn, violations);

  return violations;
}

function absLine(fn: ParsedFunction, snippetLine: number): number {
  return fn.startLine + snippetLine - 1;
}

function checkNullDereference(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip lines that already have a null guard
    if (trimmed.startsWith('if') || trimmed.startsWith('//') || trimmed.startsWith('*')) { return; }
    if (trimmed.includes('== null') || trimmed.includes('!= null') || trimmed.includes('Objects.requireNonNull')) { return; }

    // Deep property chain without optional guard: foo.bar.baz()
    const chainMatch = trimmed.match(/\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*){2,})\s*(?:\(|;|\))/);
    if (chainMatch) {
      const chain = chainMatch[1];
      if (!chain.startsWith('System.') && !chain.startsWith('this.') && !isGuardedAbove(lines, i)) {
        const parts = chain.split('.');
        violations.push({
          line: absLine(fn, i + 1),
          endLine: absLine(fn, i + 1),
          message: `Possible NullPointerException: '${chain}' — '${parts[parts.length - 2]}' may be null`,
          severity: 'warning',
          ruleId: 'java-null-deref',
          suggestedFix: `Add null check before accessing '${parts[parts.length - 2]}', or use Objects.requireNonNull()`,
        });
      }
    }
  });
}

function isGuardedAbove(lines: string[], lineIdx: number): boolean {
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 5); i--) {
    const t = lines[i].trim();
    if (t.includes('== null') || t.includes('!= null') || t.includes('requireNonNull')) { return true; }
    if (t.startsWith('if')) { return true; }
  }
  return false;
}

function checkArrayIndexOutOfBounds(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { return; }

    // arr[variable] without a preceding length check
    const match = trimmed.match(/\b([a-zA-Z_]\w*)\[([a-zA-Z_]\w*)\]/);
    if (match) {
      const arr = match[1];
      const idx = match[2];
      if (!isLengthCheckedAbove(lines, i, arr)) {
        violations.push({
          line: absLine(fn, i + 1),
          endLine: absLine(fn, i + 1),
          message: `Array access '${arr}[${idx}]' without bounds check — ArrayIndexOutOfBoundsException risk`,
          severity: 'warning',
          ruleId: 'java-array-bounds',
          suggestedFix: `Check '${idx} < ${arr}.length' before accessing '${arr}[${idx}]'`,
        });
      }
    }
  });
}

function isLengthCheckedAbove(lines: string[], lineIdx: number, arrName: string): boolean {
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 8); i--) {
    const t = lines[i].trim();
    if (t.includes(`${arrName}.length`)) { return true; }
  }
  return false;
}

function checkDivisionByZero(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { return; }

    // x / y or x % y where y is a variable (not a non-zero literal)
    const match = trimmed.match(/[^/]\s*[/%]\s*([a-zA-Z_]\w*)\b/);
    if (match) {
      const divisor = match[1];
      if (!isZeroCheckedAbove(lines, i, divisor)) {
        violations.push({
          line: absLine(fn, i + 1),
          endLine: absLine(fn, i + 1),
          message: `Division/modulo by '${divisor}' — guard against zero before this expression`,
          severity: 'error',
          ruleId: 'java-division-by-zero',
          suggestedFix: `Add: if (${divisor} == 0) throw new ArithmeticException("Division by zero")`,
        });
      }
    }
  });
}

function isZeroCheckedAbove(lines: string[], lineIdx: number, varName: string): boolean {
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 6); i--) {
    const t = lines[i].trim();
    if (t.includes(`${varName} == 0`) || t.includes(`${varName} != 0`) || t.includes(`${varName} <= 0`)) { return true; }
  }
  return false;
}

function checkUncheckedExceptions(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  const fnText = fn.text;
  const hasTryCatch = fnText.includes('try') && fnText.includes('catch');
  const hasThrowsDecl = fnText.match(/\)\s*throws\s+\w+/);

  // Look for calls that commonly throw checked exceptions
  const riskyPatterns = [
    { pattern: /new\s+FileInputStream/, name: 'FileInputStream (throws IOException)' },
    { pattern: /new\s+FileOutputStream/, name: 'FileOutputStream (throws IOException)' },
    { pattern: /Class\.forName/, name: 'Class.forName (throws ClassNotFoundException)' },
    { pattern: /\.getMethod\(/, name: 'getMethod (throws NoSuchMethodException)' },
    { pattern: /Thread\.sleep/, name: 'Thread.sleep (throws InterruptedException)' },
  ];

  if (!hasTryCatch && !hasThrowsDecl) {
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      for (const { pattern, name } of riskyPatterns) {
        if (pattern.test(trimmed)) {
          violations.push({
            line: absLine(fn, i + 1),
            endLine: absLine(fn, i + 1),
            message: `${name} — checked exception not handled: no try/catch and no 'throws' declaration`,
            severity: 'error',
            ruleId: 'java-unchecked-exception',
            suggestedFix: `Wrap in try/catch or declare 'throws' on the method signature`,
          });
        }
      }
    });
  }
}

function checkStringEqualityWithDoubleEquals(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { return; }

    // Detect: stringVar == "literal"  or  "literal" == stringVar  or  stringVar == otherVar
    // Heuristic: if the operand looks like a String (starts lowercase or is a literal)
    const match = trimmed.match(/([a-zA-Z_]\w*|"[^"]*")\s*==\s*([a-zA-Z_]\w*|"[^"]*")/);
    if (match) {
      const left = match[1];
      const right = match[2];
      const isStringComparison = left.startsWith('"') || right.startsWith('"') ||
        /^[a-z]/.test(left) || /^[a-z]/.test(right);

      if (isStringComparison) {
        violations.push({
          line: absLine(fn, i + 1),
          endLine: absLine(fn, i + 1),
          message: `String comparison with '==' compares references, not values — use '.equals()' instead`,
          severity: 'error',
          ruleId: 'java-string-equals',
          suggestedFix: `Replace '${left} == ${right}' with '${left}.equals(${right})'`,
        });
      }
    }
  });
}

function checkOffByOneLoops(fn: ParsedFunction, lines: string[], violations: RuleViolation[]): void {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { return; }

    if (/for\s*\(.*<=\s*\w+\.length/.test(trimmed)) {
      violations.push({
        line: absLine(fn, i + 1),
        endLine: absLine(fn, i + 1),
        message: `Off-by-one risk: loop condition uses '<=' with .length — last iteration is out of bounds`,
        severity: 'error',
        ruleId: 'java-off-by-one',
        suggestedFix: `Change '<=' to '<' in the loop condition`,
      });
    }
  });
}

function checkUnvalidatedParams(fn: ParsedFunction, violations: RuleViolation[]): void {
  if (fn.parameters.length < 2) { return; }

  const hasValidation = fn.text.includes('if (') || fn.text.includes('if(') ||
    fn.text.includes('throw') || fn.text.includes('Objects.requireNonNull') ||
    fn.text.includes('assert ');

  if (!hasValidation) {
    const paramNames = fn.parameters.map(p => p.split(' ').pop() ?? p).join(', ');
    violations.push({
      line: fn.startLine,
      endLine: fn.startLine,
      message: `Method '${fn.name}' accepts ${fn.parameters.length} parameters (${paramNames}) with no input validation`,
      severity: 'warning',
      ruleId: 'java-unvalidated-params',
      suggestedFix: `Validate parameters at the top of the method (null checks, range checks)`,
    });
  }
}
