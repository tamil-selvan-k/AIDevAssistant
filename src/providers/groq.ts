import { LLMProvider, LLMResponse } from './llmProvider';
import { groqLimiter } from './rateLimiter';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'];

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  async call(prompt: string, timeoutMs: number): Promise<LLMResponse> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY not set');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const models = getGroqModels();
      const modelErrors: string[] = [];

      for (const model of models) {
        if (!groqLimiter.tryConsume()) {
          throw new Error('Groq rate limit reached');
        }

        const firstAttempt = await callGroqModel(apiKey, model, prompt, controller.signal, true);
        if (firstAttempt.kind === 'ok') {
          return parseStructuredResponse(firstAttempt.content);
        }
        if (firstAttempt.kind === 'model-not-found') {
          modelErrors.push(`${model}: model_not_found`);
          continue;
        }
        if (firstAttempt.kind === 'unsupported-json-mode') {
          const secondAttempt = await callGroqModel(apiKey, model, prompt, controller.signal, false);
          if (secondAttempt.kind === 'ok') {
            return parseStructuredResponse(secondAttempt.content);
          }
          if (secondAttempt.kind === 'model-not-found') {
            modelErrors.push(`${model}: model_not_found`);
            continue;
          }
          throw new Error(`Groq HTTP ${secondAttempt.status}: ${secondAttempt.body}`);
        }
        throw new Error(`Groq HTTP ${firstAttempt.status}: ${firstAttempt.body}`);
      }

      throw new Error(`Groq model selection failed (${modelErrors.join(', ')})`);
    } finally {
      clearTimeout(timer);
    }

    type GroqCallResult =
      | { kind: 'ok'; content: string }
      | { kind: 'model-not-found'; status: number; body: string }
      | { kind: 'unsupported-json-mode'; status: number; body: string }
      | { kind: 'http-error'; status: number; body: string };

    async function callGroqModel(
      apiKey: string,
      model: string,
      prompt: string,
      signal: AbortSignal,
      useJsonMode: boolean
    ): Promise<GroqCallResult> {
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      };
      if (useJsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const rawBody = await response.text();
        const lowerBody = rawBody.toLowerCase();
        if (response.status === 404 && rawBody.includes('model_not_found')) {
          return { kind: 'model-not-found', status: response.status, body: rawBody };
        }
        if (
          useJsonMode &&
          response.status === 400 &&
          (lowerBody.includes('response_format') || lowerBody.includes('json_object'))
        ) {
          return { kind: 'unsupported-json-mode', status: response.status, body: rawBody };
        }
        return { kind: 'http-error', status: response.status, body: rawBody };
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content ?? '{}';
      return { kind: 'ok', content };
    }
  }
}

function getGroqModels(): string[] {
  const fromSingle = process.env.GROQ_MODEL?.trim();
  if (fromSingle) {
    return [fromSingle];
  }

  const fromList = process.env.GROQ_MODEL_CANDIDATES
    ?.split(',')
    .map(v => v.trim())
    .filter(Boolean);
  if (fromList && fromList.length > 0) {
    return fromList;
  }

  return DEFAULT_GROQ_MODELS;
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
