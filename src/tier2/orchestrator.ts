import * as vscode from 'vscode';
import { LLMResponse } from '../providers/llmProvider';
import { GroqProvider } from '../providers/groq';
import { OpenRouterProvider } from '../providers/openRouter';
import { GeminiProvider } from '../providers/gemini';

const groq = new GroqProvider();
const openRouter = new OpenRouterProvider();
const gemini = new GeminiProvider();

// Injected from extension.ts after the output channel is created.
// Defaults to console.warn so the module works in pipeline-dev.ts too.
type Logger = (msg: string) => void;
let _log: Logger = msg => console.warn(msg);
export function setLogger(fn: Logger): void { _log = fn; }

function isRetryable(err: Error): boolean {
  const msg = err.message;
  return msg.includes('429') || msg.includes('503') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('too many requests');
}

async function callWithRetry(
  provider: { name: string; call(prompt: string, timeoutMs: number): Promise<LLMResponse> },
  prompt: string,
  timeoutMs: number
): Promise<LLMResponse> {
  const MAX_ATTEMPTS = 2;
  let lastErr: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await provider.call(prompt, timeoutMs);
    } catch (err) {
      lastErr = err as Error;
      if (!isRetryable(lastErr) || attempt === MAX_ATTEMPTS - 1) { throw lastErr; }
      const backoff = 1000 * Math.pow(2, attempt);
      _log(`[AI Dev Assistant] ${provider.name} retryable error (attempt ${attempt + 1}), backing off ${backoff}ms: ${lastErr.message}`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function callWithFallback(prompt: string, timeoutMs: number): Promise<LLMResponse> {
  const config = vscode.workspace.getConfiguration('aiDevAssistant');
  const timeout = config.get<number>('llmTimeout') ?? timeoutMs;
  const failures: string[] = [];

  _log(`[AI Dev Assistant] Tier-2 prompt length: ${prompt.length} chars, timeout: ${timeout}ms`);

  for (const provider of [groq, openRouter, gemini]) {
    try {
      const result = await callWithRetry(provider, prompt, timeout);
      _log(`[AI Dev Assistant] ${provider.name} succeeded`);
      return result;
    } catch (err) {
      const reason = (err as Error).message;
      failures.push(`${provider.name}: ${reason}`);
      _log(`[AI Dev Assistant] ${provider.name} FAILED — ${reason}`);
    }
  }

  // Include per-provider reasons so the user can diagnose from the toast/chat output
  throw new Error(`All LLM providers failed:\n• ${failures.join('\n• ')}`);
}
