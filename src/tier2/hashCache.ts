import { createHash } from 'crypto';
import { LLMResponse } from '../providers/llmProvider';

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const PERSIST_KEY = 'aiDevAssistant.llmCache';

interface CacheEntry {
  response: LLMResponse;
  expiresAt: number;
}

// Structural interface so this module stays free of a hard vscode dependency
// (used in pipeline-dev.ts outside VS Code too).
interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const cache = new Map<string, CacheEntry>();
let _store: Memento | undefined;

/**
 * Call once from activate() to wire up persistence.
 * Loads any unexpired entries from the previous session into memory.
 */
export function initPersistence(globalState: Memento): void {
  _store = globalState;
  const stored = globalState.get<Record<string, CacheEntry>>(PERSIST_KEY) ?? {};
  const now = Date.now();
  let loaded = 0;
  for (const [key, entry] of Object.entries(stored)) {
    if (entry.expiresAt > now) {
      cache.set(key, entry);
      loaded++;
    }
  }
  if (loaded > 0) {
    console.log(`[AI Dev Assistant] Restored ${loaded} LLM result(s) from previous session.`);
  }
}

export function computeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function get(hash: string): LLMResponse | undefined {
  const entry = cache.get(hash);
  if (!entry) { return undefined; }
  if (Date.now() > entry.expiresAt) {
    cache.delete(hash);
    return undefined;
  }
  return entry.response;
}

export function set(hash: string, response: LLMResponse): void {
  const entry: CacheEntry = { response, expiresAt: Date.now() + TTL_MS };
  cache.set(hash, entry);
  persistAsync(); // fire-and-forget — never blocks the caller
}

export function clear(): void {
  cache.clear();
  _store?.update(PERSIST_KEY, {}); // fire-and-forget
}

export function size(): number {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) { cache.delete(key); }
  }
  return cache.size;
}

function persistAsync(): void {
  if (!_store) { return; }
  const now = Date.now();
  const snapshot: Record<string, CacheEntry> = {};
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) { snapshot[key] = entry; }
  }
  _store.update(PERSIST_KEY, snapshot); // returns Thenable — intentionally not awaited
}
