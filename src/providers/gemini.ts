import { LLMProvider, LLMResponse } from './llmProvider';
import { geminiLimiter } from './rateLimiter';

const GEMINI_MODEL = 'gemini-1.5-flash';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  async call(prompt: string, timeoutMs: number): Promise<LLMResponse> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    if (!geminiLimiter.tryConsume()) {
      throw new Error('Gemini rate limit reached');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini HTTP ${response.status}: ${body}`);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const content = data.candidates[0]?.content?.parts[0]?.text ?? '{}';
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
