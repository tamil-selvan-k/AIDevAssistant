import { createHash } from 'crypto';
import { LLMResponse } from '../providers/llmProvider';

const cache = new Map<string, LLMResponse>();

export function computeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function get(hash: string): LLMResponse | undefined {
  return cache.get(hash);
}

export function set(hash: string, response: LLMResponse): void {
  cache.set(hash, response);
}

export function clear(): void {
  cache.clear();
}

export function size(): number {
  return cache.size;
}
