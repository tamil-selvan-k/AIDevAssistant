import * as fs from 'fs';

export const API_KEY_ENV_VARS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDotEnv(content: string): Map<string, string> {
  const parsed = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) { continue; }
    const key = line.slice(0, eq).trim();
    const value = stripWrappingQuotes(line.slice(eq + 1).trim());
    parsed.set(key, value);
  }
  return parsed;
}

export function loadApiKeysFromDotEnvFile(dotEnvPath: string): string[] {
  if (!fs.existsSync(dotEnvPath)) { return []; }
  const content = fs.readFileSync(dotEnvPath, 'utf-8');
  const parsed = parseDotEnv(content);
  const loaded: string[] = [];

  for (const key of API_KEY_ENV_VARS) {
    if (process.env[key]) { continue; }
    const value = parsed.get(key);
    if (!value) { continue; }
    process.env[key] = value;
    loaded.push(key);
  }

  return loaded;
}

export function hasAnyApiKey(): boolean {
  return API_KEY_ENV_VARS.some(key => Boolean(process.env[key]));
}
