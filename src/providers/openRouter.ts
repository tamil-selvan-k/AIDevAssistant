import { LLMProvider, LLMResponse } from './llmProvider';
import { openRouterLimiter } from './rateLimiter';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'meta-llama/llama-3.1-8b-instruct:free';

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  async call(prompt: string, timeoutMs: number): Promise<LLMResponse> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    if (!openRouterLimiter.tryConsume()) {
      throw new Error('OpenRouter rate limit reached');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'vscode-ai-dev-assistant',
          'X-Title': 'AI Dev Assistant',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter HTTP ${response.status}: ${body}`);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content ?? '{}';
      return parseStructuredResponse(content);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseStructuredResponse(raw: string): LLMResponse {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { return { issues: [] }; }
    const parsed = JSON.parse(jsonMatch[0]) as { issues?: unknown };
    if (Array.isArray(parsed.issues)) {
      return { issues: parsed.issues as LLMResponse['issues'] };
    }
    return { issues: [] };
  } catch {
    return { issues: [] };
  }
}
