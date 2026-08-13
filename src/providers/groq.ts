import { LLMProvider, LLMResponse } from './llmProvider';
import { groqLimiter } from './rateLimiter';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  async call(prompt: string, timeoutMs: number): Promise<LLMResponse> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY not set');
    }

    if (!groqLimiter.tryConsume()) {
      throw new Error('Groq rate limit reached');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Groq HTTP ${response.status}: ${body}`);
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
    const parsed = JSON.parse(raw) as { issues?: unknown };
    if (Array.isArray(parsed.issues)) {
      return { issues: parsed.issues as LLMResponse['issues'], analysisNote: undefined };
    }
    return { issues: [] };
  } catch {
    return { issues: [] };
  }
}
