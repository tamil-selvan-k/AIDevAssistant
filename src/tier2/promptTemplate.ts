import { FunctionContext } from './contextBuilder';

const RESPONSE_SCHEMA = `{
  "issues": [
    {
      "line": <integer — 1-based line number within the function>,
      "severity": "<error|warning|info>",
      "category": "<value-invariant|state-invariant|logic|edge-case>",
      "message": "<concise description of the bug>",
      "suggestedFix": "<concrete fix recommendation>"
    }
  ]
}`;

export function buildPrompt(ctx: FunctionContext): string {
  return `You are a senior software engineer performing a focused business-logic and edge-case review.
Analyze ONLY the function below for:
1. Value-invariant bugs — inputs that produce mathematically impossible or business-rule-violating outputs (e.g., discount > 100% producing negative price)
2. State-invariant bugs — illegal state transitions (e.g., refunded → shipped)
3. Missing range/bound checks on business parameters
4. Logic errors that pass type-checking but violate the stated intent in the docstring

DO NOT report:
- Syntax errors or type errors (the compiler handles those)
- Style issues
- Issues already caught by null-check linters

IMPORTANT:
- Only flag issues you are highly confident about given the docstring as the intent signal
- If the function looks correct, return {"issues": []}
- Base your analysis on the docstring/comment as the authoritative intent

Function to analyze:
\`\`\`typescript
${ctx.functionCode}
\`\`\`

Docstring / intent: ${ctx.docstring || '(none provided)'}
Function name: ${ctx.functionName}
Parameters: ${ctx.parameters.join(', ')}
Return type: ${ctx.returnType}
Starting at line: ${ctx.startLine}

Respond ONLY with valid JSON matching this exact schema — no prose, no markdown fences:
${RESPONSE_SCHEMA}`;
}
