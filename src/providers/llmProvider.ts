export interface LLMIssue {
  line: number;
  severity: 'error' | 'warning' | 'info';
  category: 'value-invariant' | 'state-invariant' | 'logic' | 'edge-case';
  message: string;
  suggestedFix: string;
}

export interface LLMResponse {
  issues: LLMIssue[];
  analysisNote?: string;
}

export interface LLMProvider {
  readonly name: string;
  call(prompt: string, timeoutMs: number): Promise<LLMResponse>;
}
