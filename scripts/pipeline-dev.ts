/**
 * Standalone Phase-1 dev harness.
 * Run: pnpm run harness
 * Tests Tier-1 + Tier-2 pipeline against all 4 demo scenarios without VS Code.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseFile as parseTSFile } from '../src/tier1/astParser';
import { parseJavaFile } from '../src/tier1/javaAdapter';
import { runRules as runTSRules } from '../src/tier1/ruleEngine';
import { runJavaRules } from '../src/tier1/javaRuleEngine';
import { isInteresting } from '../src/tier2/interestFilter';
import { buildContext } from '../src/tier2/contextBuilder';
import { buildPrompt } from '../src/tier2/promptTemplate';
import * as hashCache from '../src/tier2/hashCache';
import { GroqProvider } from '../src/providers/groq';
import { OpenRouterProvider } from '../src/providers/openRouter';
import { GeminiProvider } from '../src/providers/gemini';
import { LLMProvider, LLMResponse } from '../src/providers/llmProvider';
import { ParsedFunction } from '../src/tier1/astParser';
import { RuleViolation } from '../src/tier1/ruleEngine';

interface Scenario {
  file: string;
  name: string;
  lang: 'ts' | 'java';
}

const SCENARIOS: Scenario[] = [
  { file: 'test/scenario-a.ts', name: 'Scenario A (Tier-1: null access — JS/TS)', lang: 'ts' },
  { file: 'test/scenario-b.ts', name: 'Scenario B (Tier-2: value-invariant — JS/TS)', lang: 'ts' },
  { file: 'test/scenario-c.ts', name: 'Scenario C (Tier-2: state-invariant — JS/TS)', lang: 'ts' },
  { file: 'test/scenario-d.java', name: 'Scenario D (Tier-1: String == comparison — Java)', lang: 'java' },
];

const TIMEOUT_MS = 10_000;

const providers: LLMProvider[] = [
  new GroqProvider(),
  new OpenRouterProvider(),
  new GeminiProvider(),
];

async function callWithFallback(prompt: string): Promise<LLMResponse> {
  for (const provider of providers) {
    try {
      console.log(`    → Trying ${provider.name}...`);
      const result = await provider.call(prompt, TIMEOUT_MS);
      console.log(`    ✓ ${provider.name} responded`);
      return result;
    } catch (err) {
      console.warn(`    ✗ ${provider.name} failed: ${(err as Error).message}`);
    }
  }
  throw new Error('All providers failed');
}

function parseByLang(lang: 'ts' | 'java', filePath: string, source: string) {
  return lang === 'java' ? parseJavaFile(filePath, source) : parseTSFile(filePath, source);
}

function runRulesByLang(lang: 'ts' | 'java', fn: ParsedFunction, filePath: string): RuleViolation[] {
  return lang === 'java' ? runJavaRules(fn) : runTSRules(fn, filePath);
}

async function runScenario(scenario: Scenario): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${scenario.name}`);
  console.log('='.repeat(60));

  const filePath = path.join(process.cwd(), scenario.file);
  const sourceText = fs.readFileSync(filePath, 'utf-8');

  console.log(`\n[1] Parsing AST (${scenario.lang.toUpperCase()}) from ${scenario.file}...`);
  const parseResult = parseByLang(scenario.lang, filePath, sourceText);
  console.log(`    Found ${parseResult.functions.length} function(s): ${parseResult.functions.map(f => f.name).join(', ')}`);

  for (const fn of parseResult.functions) {
    console.log(`\n--- ${scenario.lang === 'java' ? 'Method' : 'Function'}: ${fn.name} (lines ${fn.startLine}–${fn.endLine}) ---`);
    console.log(`    hasDocstring: ${fn.hasDocstring}`);
    console.log(`    params: ${fn.parameters.join(', ') || '(none)'}`);

    console.log('\n[2] Running Tier-1 rules...');
    const violations = runRulesByLang(scenario.lang, fn, filePath);
    if (violations.length === 0) {
      console.log('    No Tier-1 violations.');
    } else {
      for (const v of violations) {
        console.log(`    [${v.severity.toUpperCase()}] Line ${v.line} [${v.ruleId}]: ${v.message}`);
        console.log(`           Fix: ${v.suggestedFix}`);
      }
    }

    console.log('\n[3] Checking InterestFilter...');
    const interesting = isInteresting(fn);
    console.log(`    isInteresting: ${interesting}`);

    if (!interesting) {
      console.log('    Skipping Tier-2 (not interesting).');
      continue;
    }

    const ctx = buildContext(fn);
    const prompt = buildPrompt(ctx);

    console.log('\n[4] Built prompt (first 300 chars):');
    console.log('    ' + prompt.slice(0, 300).replace(/\n/g, '\n    ') + '...');

    console.log('\n[5] Checking hash cache...');
    const cached = hashCache.get(fn.hash);
    if (cached) {
      console.log('    CACHE HIT');
      printLLMResult(cached);
      continue;
    }
    console.log('    CACHE MISS — calling LLM...');

    try {
      const result = await callWithFallback(prompt);
      hashCache.set(fn.hash, result);
      console.log('\n[6] LLM response:');
      printLLMResult(result);
    } catch (err) {
      console.error(`\n[6] All providers failed: ${(err as Error).message}`);
      console.log('    Tier-2 unavailable — Tier-1 results stand.');
    }
  }
}

function printLLMResult(result: LLMResponse): void {
  if (result.issues.length === 0) {
    console.log('    No issues detected by LLM.');
    return;
  }
  for (const issue of result.issues) {
    console.log(`    [${issue.severity.toUpperCase()}] Line ${issue.line} [${issue.category}]: ${issue.message}`);
    console.log(`           Fix: ${issue.suggestedFix}`);
  }
}

async function main(): Promise<void> {
  console.log('AI Dev Assistant — Pipeline Dev Harness (JS/TS + Java)');
  console.log('Testing all 4 demo scenarios\n');

  const hasAnyKey = process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  if (!hasAnyKey) {
    console.warn('WARNING: No API keys set. Tier-2 calls will fail.\n');
    console.warn('Set: GROQ_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY\n');
  }

  for (const scenario of SCENARIOS) {
    await runScenario(scenario);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Pipeline harness complete.');
  console.log(`  Cache entries: ${hashCache.size()}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
