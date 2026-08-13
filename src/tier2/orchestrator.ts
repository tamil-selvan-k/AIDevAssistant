import * as vscode from 'vscode';
import { LLMResponse } from '../providers/llmProvider';
import { GroqProvider } from '../providers/groq';
import { OpenRouterProvider } from '../providers/openRouter';
import { GeminiProvider } from '../providers/gemini';

const groq = new GroqProvider();
const openRouter = new OpenRouterProvider();
const gemini = new GeminiProvider();

export async function callWithFallback(prompt: string, timeoutMs: number): Promise<LLMResponse> {
  const config = vscode.workspace.getConfiguration('aiDevAssistant');
  const timeout = config.get<number>('llmTimeout') ?? timeoutMs;

  for (const provider of [groq, openRouter, gemini]) {
    try {
      return await provider.call(prompt, timeout);
    } catch (err) {
      console.warn(`[AI Dev Assistant] ${provider.name} failed: ${(err as Error).message}`);
    }
  }
  throw new Error('All LLM providers failed or timed out');
}
