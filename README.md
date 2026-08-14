# AI Dev Assistant

A VS Code extension that continuously watches JavaScript, TypeScript, and Java code for edge cases and business-logic bugs. Combines fast local static analysis (Tier-1) with LLM-assisted reasoning (Tier-2). Output is suggest-only — no auto-fix, no auto-apply.

## Features

### Tier-1 — Instant static analysis (no network, no LLM)
Runs synchronously on every save. Detects:
- Null/undefined access without guard (`user.profile.email` where `profile` is optional)
- Array access without bounds check
- Division or modulo by zero
- Unhandled promise rejections
- Loose equality (`==` instead of `===`)
- Off-by-one loop errors
- Functions that accept parameters with no input validation
- Java: `String ==` reference comparison instead of `.equals()`

### Tier-2 — LLM business-logic analysis (requires API key)
Fires after Tier-1 **only for functions that passed Tier-1 cleanly** (no static violations found). If Tier-1 already flagged a function, the LLM call is skipped entirely — saving API quota and latency. Detects:
- **Value-invariant bugs** — inputs that produce mathematically impossible outputs (e.g. discount > 100% → negative price)
- **State-invariant bugs** — illegal state transitions (e.g. `refunded → shipped`)
- Missing range/bound checks on business parameters

Results are cached by content hash — the LLM is not re-called until the function actually changes.

### `@devassistant` Chat Participant
Ask questions about the open file directly in VS Code Chat:
```
@devassistant what's wrong with this function?
@devassistant review the selected method
```

## Supported Languages
- JavaScript (`.js`, `.jsx`)
- TypeScript (`.ts`, `.tsx`)
- Java (`.java`) — uses pure-JS parser, no JDK required

## Requirements
- VS Code 1.85+
- Node.js 18+ (for native `fetch`)
- pnpm 9+
- At least one LLM API key for Tier-2 (Groq recommended — free tier available)

## Setup

### 1. Install dependencies
```bash
pnpm install
```

### 2. Set API keys

**Option A — VS Code Settings (recommended)**

Open Settings (`Ctrl+,`), search for `aiDevAssistant`, and fill in:
- `AI Dev Assistant: Groq Api Key` — primary provider (fastest, free tier)
- `AI Dev Assistant: Open Router Api Key` — fallback 1
- `AI Dev Assistant: Gemini Api Key` — fallback 2

**Option B — Environment variables**
```bash
export GROQ_API_KEY=gsk_...
export OPENROUTER_API_KEY=sk-or-...
export GEMINI_API_KEY=AIza...
```

Get a free Groq key at [console.groq.com](https://console.groq.com).

### 3. Build
```bash
pnpm run compile
```

### 4. Run (press F5 in VS Code)
This opens an **Extension Development Host** window with the test scenario pre-loaded. Open the Output panel (`View → Output`) and select **"AI Dev Assistant"** from the dropdown to see the analysis log.

## Usage

The extension activates automatically when you open a JS/TS/Java file. Analysis triggers on:
- **File open** — immediate Tier-1 scan
- **File save** (`Ctrl+S`) — re-runs Tier-1 and triggers Tier-2 for changed functions

Findings appear as:
- Inline squiggles in the editor
- Entries in the **Problems** panel (`Ctrl+Shift+M`)
- `[Tier-1]` prefix for static findings, `[Tier-2]` prefix for LLM findings

### Commands (Command Palette — `Ctrl+Shift+P`)
| Command | Description |
|---------|-------------|
| `AI Dev Assistant: Analyze Current File` | Force re-analyze the active file |
| `AI Dev Assistant: Clear Analysis Cache` | Clear LLM cache and all diagnostics |

## Demo Scenarios

Three fixture files in `test/` demonstrate each detection tier:

| File | Bug | Tier |
|------|-----|------|
| `test/scenario-a.ts` | `user.profile.email` — `profile` may be undefined | Tier-1 |
| `test/scenario-b.ts` | `applyDiscount` — `discountPercent > 100` produces negative price | Tier-2 |
| `test/scenario-c.ts` | `updateOrderStatus` — allows `refunded → shipped` (illegal transition) | Tier-2 |
| `test/scenario-d.java` | `hasRole` — `==` compares String references, not values | Tier-1 |

### Running the standalone harness (no VS Code needed)
```bash
pnpm run harness
```
Tests all four scenarios end-to-end, including live LLM calls. Useful for validating API keys and prompt changes.

## Development

```bash
# Compile TypeScript
pnpm run compile

# Watch mode
pnpm run watch

# Run harness (tests all 4 scenarios)
pnpm run harness

# Package as .vsix for sideloading
npx vsce package
```

## Architecture

```
src/
  extension.ts           # activation, event wiring, diagnostic lifecycle
  tier1/
    astParser.ts         # ts-morph AST parsing (JS/TS)
    javaAdapter.ts       # java-parser CST parsing (Java, pure JS — no JDK)
    ruleEngine.ts        # 7 deterministic TS/JS rules
    javaRuleEngine.ts    # 7 deterministic Java rules
    languageAdapter.ts   # routes JS/TS → ruleEngine, Java → javaRuleEngine
    diagnosticMapper.ts  # rule violations → vscode.Diagnostic
  tier2/
    interestFilter.ts    # heuristic: does this function have business-logic keywords?
    contextBuilder.ts    # extracts function context for the prompt
    promptTemplate.ts    # JSON-schema-constrained prompt
    hashCache.ts         # sha256 content-hash → cached LLM result (in-memory)
    orchestrator.ts      # Groq → OpenRouter → Gemini fallback chain
  providers/
    groq.ts / openRouter.ts / gemini.ts
    rateLimiter.ts       # client-side token bucket
  chat/
    chatParticipant.ts   # @devassistant handler, streamed markdown
```

**End-to-end flow on save:**
1. `onDidSaveTextDocument` fires
2. AST diff isolates changed functions
3. Tier-1 rules run synchronously → squiggles render immediately
4. `InterestFilter` checks if changed functions qualify for Tier-2
5. **Functions with Tier-1 violations are excluded from Tier-2** — no LLM call made
6. Hash cache lookup — LLM skipped on hit
7. On miss: Groq → OpenRouter → Gemini with 5s timeout per provider
7. Structured JSON response mapped to `vscode.Diagnostic[]`
8. Result cached; Tier-2 squiggles added to Problems panel

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aiDevAssistant.enableTier2` | `true` | Toggle LLM analysis on/off |
| `aiDevAssistant.llmTimeout` | `5000` | Timeout per LLM call (ms) |
| `aiDevAssistant.groqApiKey` | `""` | Groq API key |
| `aiDevAssistant.openRouterApiKey` | `""` | OpenRouter API key |
| `aiDevAssistant.geminiApiKey` | `""` | Gemini API key |
