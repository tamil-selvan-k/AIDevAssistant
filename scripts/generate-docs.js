/**
 * Generates docs/architecture.pdf
 * Run: node scripts/generate-docs.js
 */
'use strict';
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'docs', 'architecture.pdf');
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 55, right: 55 } });
doc.pipe(fs.createWriteStream(OUT_PATH));

const W = doc.page.width - 110;
const L = 55;

const C = {
  accent:   '#4f8ef7',
  alt:      '#7c6af7',
  green:    '#4ec994',
  yellow:   '#f7c948',
  red:      '#f75f5f',
  text:     '#1a1a2e',
  muted:    '#555577',
  codeBg:   '#f0f2f8',
  border:   '#d0d4e8',
};

function ensureSpace(n) {
  if (doc.y + n > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function pageHeader(section) {
  if (doc.bufferedPageRange().count > 0) doc.addPage();
  doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
     .text('AI Dev Assistant — Architecture & Flow  |  ' + section, L, 22, { width: W });
  doc.save().moveTo(L, 33).lineTo(L + W, 33)
     .strokeColor(C.border).lineWidth(0.5).stroke().restore();
  doc.y = 46;
}

function h1(t) {
  ensureSpace(50);
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(18).fillColor(C.accent).text(t, L, doc.y, { width: W });
  doc.moveDown(0.2);
  doc.save().moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(C.accent).lineWidth(1.5).stroke().restore();
  doc.moveDown(0.5);
}

function h2(t) {
  ensureSpace(35);
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12).fillColor(C.alt).text(t, L, doc.y, { width: W }).moveDown(0.2);
}

function h3(t) {
  ensureSpace(25);
  doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10).fillColor(C.yellow).text(t, L, doc.y, { width: W }).moveDown(0.1);
}

function body(t) {
  doc.font('Helvetica').fontSize(9.5).fillColor(C.text).text(t, L, doc.y, { width: W, lineGap: 2 }).moveDown(0.3);
}

function bullet(items) {
  items.forEach(item => {
    ensureSpace(16);
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(C.accent).text('•', L, y, { width: 12, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(C.text).text(item, L + 16, y, { width: W - 16, lineGap: 2 });
    doc.moveDown(0.15);
  });
  doc.moveDown(0.2);
}

function code(lines) {
  const h = lines.length * 12 + 16;
  ensureSpace(h);
  doc.save().rect(L, doc.y, W, h).fillColor(C.codeBg).fill().restore();
  const sy = doc.y + 8;
  lines.forEach((line, i) => {
    doc.font('Courier').fontSize(8).fillColor('#1a3a5c').text(line, L + 8, sy + i * 12, { width: W - 16, lineBreak: false });
  });
  doc.y = sy + lines.length * 12 + 4;
  doc.moveDown(0.35);
}

function divider() {
  doc.moveDown(0.3);
  doc.save().moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(C.border).lineWidth(0.5).stroke().restore();
  doc.moveDown(0.4);
}

function twoCol(rows) {
  const c1 = W * 0.38, c2 = W * 0.58, gap = W * 0.04;
  rows.forEach(([a, b]) => {
    ensureSpace(16);
    const y = doc.y;
    doc.font('Courier').fontSize(8.5).fillColor(C.green).text(a, L, y, { width: c1 });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.text).text(b, L + c1 + gap, y, { width: c2, lineGap: 2 });
    doc.moveDown(0.2);
  });
  doc.moveDown(0.2);
}

// ── COVER ────────────────────────────────────────────────────────────────────
doc.rect(0, 0, doc.page.width, doc.page.height).fillColor('#0a0d18').fill();
doc.rect(0, 0, 8, doc.page.height).fillColor(C.accent).fill();

const cy = doc.page.height / 2 - 90;
doc.font('Helvetica-Bold').fontSize(34).fillColor('#ffffff').text('AI Dev Assistant', L + 12, cy, { width: W });
doc.font('Helvetica').fontSize(17).fillColor(C.alt).text('Architecture & Flow', L + 12, cy + 50, { width: W });
doc.font('Helvetica').fontSize(10).fillColor('#8890aa')
   .text('Extension internals, cache design, and end-to-end analysis pipeline', L + 12, cy + 80, { width: W });
doc.font('Helvetica').fontSize(9).fillColor('#8890aa')
   .text('Generated: ' + new Date().toDateString(), L + 12, doc.page.height - 60, { width: W });

// ── PAGE 1: OVERVIEW & CACHE ─────────────────────────────────────────────────
pageHeader('Overview & Cache Storage');

h1('1. Overview');
body(
  'AI Dev Assistant is a VS Code extension that continuously watches JavaScript, TypeScript, and Java ' +
  'files for edge-case and business-logic bugs. It runs entirely inside the VS Code extension host — ' +
  'no backend server, no external process. Analysis is split into two tiers to give instant local ' +
  'feedback while reserving LLM calls only for functions that static analysis cannot reason about.'
);
h2('Design Principles');
bullet([
  'Tier-1 always renders before Tier-2 is invoked — responsiveness never depends on network latency.',
  'LLM output is always structured JSON — results map directly to vscode.Diagnostic without free-text parsing.',
  '5-second timeout on LLM calls — falls back to Tier-1 only, never hangs the editor.',
  'Tier-2 is skipped entirely if Tier-1 already flagged the function — saves API quota.',
  'Tier-1 works fully offline — no internet required for static analysis.',
  'Output is suggest-only — no auto-fix, no auto-apply.',
]);
divider();

h1('2. Cache Storage');
body(
  'The extension maintains three in-memory caches, all living in the VS Code extension host ' +
  'Node.js process. None are persisted to disk. All reset on VS Code restart or via the ' +
  '"AI Dev Assistant: Clear Analysis Cache" command.'
);

h2('Cache 1 — LLM Response Cache  (src/tier2/hashCache.ts)');
code([
  'const cache = new Map<string, LLMResponse>();',
  '//                    ^           ^',
  '//   key: SHA-256 of function text   value: parsed LLM JSON response',
]);
bullet([
  'Key: SHA-256 hex hash of the function\'s full source text (Node crypto module).',
  'Value: LLMResponse — { issues: LLMIssue[] } with line, severity, message, suggestedFix.',
  'A cache hit means the LLM is never called again for an unchanged function across saves.',
  'The hash changes only if the function body changes; any edit triggers a fresh LLM call.',
  'Size: unbounded Map — grows until reloaded or cleared via the command.',
]);

h2('Cache 2 — Diagnostic Lifecycle Cache  (extension.ts)');
code([
  'const llmDiagnosticsByHash = new Map<',
  '  string,                  // file path (absolute)',
  '  Map<string,              // function SHA-256 hash',
  '      vscode.Diagnostic[]> // LLM diagnostics for that function',
  '>();',
]);
bullet([
  'Outer key: absolute file path. Inner key: function hash.',
  'On every save, functions no longer present are pruned — prevents ghost diagnostics.',
  'publishDiagnostics() merges tier1Diagnostics + all llmStore values atomically.',
]);

h2('Cache 3 — Function Map  (extension.ts)');
code([
  'const prevFunctionMap = new Map<string, ParsedFunction[]>();',
  '//                               ^file path  ^last-seen functions',
]);
bullet([
  'Enables diffFunctions() — only changed functions are forwarded to Tier-2.',
  'On first open, prev is empty so all functions run through the full pipeline.',
]);

// ── PAGE 2: REPO STRUCTURE ──────────────────────────────────────────────────
pageHeader('Repository Structure');

h1('3. Repository Structure');
twoCol([
  ['src/extension.ts',           'Activation entry, event wiring, diagnostic lifecycle'],
  ['src/tier1/astParser.ts',      'ts-morph in-memory project; extracts ParsedFunction[] from JS/TS'],
  ['src/tier1/javaAdapter.ts',    'java-parser CST walker; extracts Java methods (pure JS, no JDK)'],
  ['src/tier1/ruleEngine.ts',     '7 deterministic JS/TS rules'],
  ['src/tier1/javaRuleEngine.ts', '7 deterministic Java rules'],
  ['src/tier1/languageAdapter.ts','Dispatcher: java → javaAdapter/javaRuleEngine, else → astParser/ruleEngine'],
  ['src/tier1/diagnosticMapper.ts','Maps RuleViolation[] + LLMIssue[] → vscode.Diagnostic[] with line offsets'],
  ['src/tier2/interestFilter.ts', 'Business-logic keyword filter — decides if LLM is warranted'],
  ['src/tier2/contextBuilder.ts', 'Extracts FunctionContext (name, code, params, return type, docstring)'],
  ['src/tier2/promptTemplate.ts', 'JSON-schema-constrained prompt builder'],
  ['src/tier2/hashCache.ts',      'SHA-256 keyed in-memory Map for LLM responses'],
  ['src/tier2/orchestrator.ts',   'callWithFallback() — Groq → OpenRouter → Gemini with timeout'],
  ['src/providers/groq.ts',       'Primary: llama-3.1-8b-instant, JSON mode, 5s timeout'],
  ['src/providers/openRouter.ts', 'Fallback 1 — OpenRouter API'],
  ['src/providers/gemini.ts',     'Fallback 2 — Google Gemini free tier'],
  ['src/providers/rateLimiter.ts','Client-side token bucket per provider'],
  ['src/chat/chatParticipant.ts', '@devassistant VS Code Chat handler, streamed markdown'],
  ['scripts/pipeline-dev.ts',     'Standalone harness — tests 4 scenarios outside VS Code'],
  ['test/scenario-a.ts',          'Fixture: getUserEmail — null access (Tier-1)'],
  ['test/scenario-b.ts',          'Fixture: applyDiscount — discount > 100% (Tier-2)'],
  ['test/scenario-c.ts',          'Fixture: updateOrderStatus — illegal transition (Tier-2)'],
  ['test/scenario-d.java',        'Fixture: hasRole — String == comparison (Tier-1 Java)'],
]);

// ── PAGE 3: END-TO-END FLOW ─────────────────────────────────────────────────
pageHeader('End-to-End Analysis Flow');

h1('4. End-to-End Flow on File Open / Save');

h2('Step 1 — Trigger');
body('onDidOpenTextDocument fires when a file is opened. onDidSaveTextDocument fires on Ctrl+S. ' +
     'isSupportedLanguage() checks the languageId: javascript, typescript, javascriptreact, typescriptreact, java.');

h2('Step 2 — AST Parsing');
bullet([
  'JS/TS: ts-morph creates an in-memory Project, extracts FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression.',
  'Java: java-parser (ANTLR-based, pure JS) produces a CST; javaAdapter walks it recursively to find method nodes.',
  'Each function gets a SHA-256 hash of its text — the stable identity key for both caches.',
]);

h2('Step 3 — Change Detection');
code([
  'diffFunctions(prev, current)  →  only functions whose hash changed since last save',
  '',
  '// Keyed on (name + startLine) to handle overloaded and anonymous functions',
  'prevMap.get(`${f.name}:${f.startLine}`) !== f.hash  →  "changed"',
]);

h2('Step 4 — Tier-1 (synchronous, instant)');
body('runRulesByLanguage() is called for ALL current functions. Results are mapped to ' +
     'vscode.Diagnostic[] and published immediately via diagnosticCollection.set() — squiggles appear before any LLM call.');

h2('Step 5 — Tier-2 Gate (four conditions)');
code([
  '1.  changed.length > 0              // at least one function changed',
  '2.  enableTier2 setting is true     // not disabled in VS Code settings',
  '3.  isInteresting(fn) === true      // name/body contains a business-logic keyword',
  '4.  tier1HitsByHash.get(fn.hash)    // Tier-1 found ZERO violations for this function',
  '         === 0                      // → if Tier-1 flagged it, LLM is skipped entirely',
]);

h2('Step 6 — Interest Filter');
body('Checks function name and body for business-logic keywords:');
code([
  'calculate, calc, validate, apply, transition, process, compute,',
  'charge, price, discount, cost, fee, order, status,',
  'auth, authorize, permission, role, limit, quota, threshold,',
  'balance, payment, refund, schedule, expire',
]);

h2('Step 7 — Hash Cache Lookup');
body('hashCache.get(fn.hash) — a hit reuses the cached LLMResponse immediately. ' +
     'A miss proceeds to callWithFallback().');

h2('Step 8 — LLM Call + Fallback');
code([
  'Groq (llama-3.1-8b-instant)  ──► primary  (json_mode enforced)',
  '  ↓ fail / timeout',
  'OpenRouter  ──────────────────► fallback 1',
  '  ↓ fail / timeout',
  'Gemini free tier  ────────────► fallback 2',
  '  ↓ all failed',
  'throw Error  ─────────────────► showWarningMessage("Open Settings")',
]);

h2('Step 9 — Response Parsing & Diagnostic Publishing');
code([
  'LLM returns:  { "issues": [{ "line": 3, "severity": "error",',
  '               "category": "value-invariant", "message": "...", "suggestedFix": "..." }] }',
  '',
  '// issue.line is 1-based and relative to function start',
  'absoluteLine(0-based) = fnStartLine + issue.line - 2',
  '',
  '// Merged and published atomically:',
  'diagnosticCollection.set(uri, [...tier1Diagnostics, ...llmStore.values().flat()])',
]);

// ── PAGE 4: TIER-1 RULES ────────────────────────────────────────────────────
pageHeader('Tier-1 Rules Reference');

h1('5. Tier-1 Rules');

h2('JavaScript / TypeScript  (src/tier1/ruleEngine.ts)');

h3('null-access');
body('Detects property chains depth ≥ 3 without optional chaining where the intermediate property is not null-guarded.');
code(['TRIGGERS: user.profile.email   (no guard)',  'SAFE:     user?.profile?.email  (optional chaining)']);

h3('array-bounds');
body('Detects element access with a non-literal index outside any conditional guard.');
code(['TRIGGERS: arr[i]  (no length check)', 'SAFE:     i < arr.length ? arr[i] : undefined']);

h3('division-by-zero');
body('Detects division (/) or modulo (%) where the denominator is a variable, not a non-zero literal.');
code(['TRIGGERS: total / count  (count may be 0)', 'SAFE:     total / 2     (literal non-zero)']);

h3('unhandled-promise');
body('Detects await expressions not enclosed in a try/catch within their immediately enclosing async function.');
code(['TRIGGERS: async fn() { const r = await fetch(url); }', 'SAFE:     async fn() { try { await fetch(url); } catch(e) {} }']);

h3('loose-equality');
body('Detects == and != operators that allow implicit type coercion.');
code(['TRIGGERS: x == y,  x != null', 'FIX:      x === y, x !== null']);

h3('off-by-one');
body('Detects for loops using <= with .length — the last iteration accesses an out-of-bounds index.');
code(['TRIGGERS: for (let i = 0; i <= arr.length; i++)', 'FIX:      for (let i = 0; i < arr.length;  i++)']);

h3('unvalidated-params');
body('Detects functions with ≥ 2 parameters that contain no if statement or throw — no input validation present.');
code(['TRIGGERS: function process(a, b) { return a + b; }', 'SAFE:     function process(a, b) { if (!a) throw ...; return a + b; }']);

divider();

h2('Java  (src/tier1/javaRuleEngine.ts)');
bullet([
  'java-null-deref  — chained method call (a.getB().getC()) without null guard',
  'java-array-bounds — arr[i] access without a length check',
  'java-division-by-zero — division/modulo with variable denominator',
  'java-unchecked-exception — RuntimeException subclass thrown without documentation',
  'java-string-equals — String comparison with == instead of .equals()',
  'java-off-by-one — for loop with <= array.length condition',
  'java-unvalidated-params — method with ≥ 2 params and no input validation',
]);

// ── PAGE 5: CONFIG & DEMO ───────────────────────────────────────────────────
pageHeader('Configuration & Demo Scenarios');

h1('6. Configuration');
twoCol([
  ['enableTier2',       'boolean, default true — toggle LLM analysis on/off'],
  ['llmTimeout',         'number, default 5000 — per-provider timeout in ms'],
  ['groqApiKey',         'Groq API key — primary provider. Falls back to GROQ_API_KEY env var'],
  ['openRouterApiKey',   'OpenRouter key — fallback 1. Falls back to OPENROUTER_API_KEY env var'],
  ['geminiApiKey',       'Gemini key — fallback 2. Falls back to GEMINI_API_KEY env var'],
]);

h2('API Key Resolution Order (at extension activation)');
code([
  '1.  process.env.GROQ_API_KEY         (env var — must be set before VS Code starts)',
  '2.  aiDevAssistant.groqApiKey        (VS Code settings: Ctrl+, → search groqApiKey)',
  '',
  'Tip: use VS Code settings if the env var is not visible to the VS Code process.',
]);

divider();

h1('7. Demo Scenario Matrix');
body('All four scenarios can be verified with: pnpm run harness');
doc.moveDown(0.3);

// table header
const cols = [W*0.14, W*0.2, W*0.09, W*0.16, W*0.38];
const cx   = [L, L+cols[0], L+cols[0]+cols[1], L+cols[0]+cols[1]+cols[2], L+cols[0]+cols[1]+cols[2]+cols[3]];
const hdrs = ['Scenario', 'Function', 'Tier', 'Rule', 'Bug detected'];
ensureSpace(20);
const hy = doc.y;
doc.save().rect(L, hy, W, 16).fillColor('#e0e8f8').fill().restore();
hdrs.forEach((h, i) => {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.accent)
     .text(h, cx[i]+3, hy+4, { width: cols[i]-3, lineBreak: false });
});
doc.y = hy + 18;

const scRows = [
  ['A', 'getUserEmail(user)', 'Tier-1', 'null-access', 'user.profile.email — profile may be undefined'],
  ['B', 'applyDiscount(price, pct)', 'Tier-2', 'value-invariant', 'discountPercent > 100 → negative price'],
  ['C', 'updateOrderStatus(cur, new)', 'Tier-2', 'state-invariant', 'refunded → shipped is illegal transition'],
  ['D (Java)', 'hasRole(role, req)', 'Tier-1', 'java-string-equals', 'String == compares references, not values'],
];
const rowCols = [[C.text, C.green, C.alt, C.red, C.text], [C.text, C.green, C.accent, C.red, C.text],
                 [C.text, C.green, C.accent, C.red, C.text], [C.text, C.green, C.alt, C.red, C.text]];
scRows.forEach((row, ri) => {
  ensureSpace(18);
  const ry = doc.y;
  if (ri % 2 === 0) doc.save().rect(L, ry, W, 15).fillColor('#f5f7fd').fill().restore();
  row.forEach((cell, i) => {
    doc.font(i < 2 ? 'Courier' : 'Helvetica').fontSize(7.5).fillColor(rowCols[ri][i])
       .text(cell, cx[i]+3, ry+3, { width: cols[i]-3, lineBreak: false });
  });
  doc.y = ry + 16;
});

doc.end();
console.log('✓ Generated:', OUT_PATH);
