// Test runner (evals): sends each case in evals/cases.json through the SAME runAgent()
// customers use, reads the trace, and checks it against the case's "expect" rules.
//
//   npm run eval                 run all cases
//   npm run eval -- barcelona    run cases whose id or group contains "barcelona"
//   npm run eval -- --repeat 3   run each case 3 times (LLMs vary a little)
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findById } from '../src/customers.js';
import { runTurn } from '../src/turn.js';
import { guardOutput, findInventedPrices } from '../src/guardrails.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const repeat = Number(args[args.indexOf('--repeat') + 1]) || 1;
const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat')?.toLowerCase();

// lower-case + treat curly apostrophes (’ ‘) like a straight one, so "don’t" matches "don't"
const lower = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'");

// ---------- checks: each returns null (pass) or a short reason (fail) ----------
const CHECKS = {
  tools: (want, t) => {
    const missing = want.filter((n) => !t.tools.includes(n));
    return missing.length ? `expected tool ${missing.join(', ')}, got ${t.tools.join(', ') || 'none'}` : null;
  },
  anyTools: (want, t) => (want.some((n) => t.tools.includes(n)) ? null : `expected one of ${want.join(' / ')}, got ${t.tools.join(', ') || 'none'}`),
  notTools: (bad, t) => { const hit = bad.filter((n) => t.tools.includes(n)); return hit.length ? `should not call ${hit.join(', ')}` : null; },
  noTools: (on, t) => (on && t.tools.length ? `expected no tools, got ${t.tools.join(', ')}` : null),
  toolArgs: (want, t) => {
    for (const [tool, expected] of Object.entries(want)) {
      const calls = t.calls.filter((c) => c.name === tool);
      if (!calls.length) return `${tool} was not called`;
      const ok = calls.some((c) => Object.entries(expected).every(([k, v]) =>
        typeof v === 'number' ? Number(c.args?.[k]) === v : lower(c.args?.[k]).includes(lower(v))));
      if (!ok) return `${tool} args ${JSON.stringify(calls.map((c) => c.args))} ≠ ${JSON.stringify(expected)}`;
    }
    return null;
  },
  contains: (words, t) => { const miss = words.filter((w) => !lower(t.reply).includes(lower(w))); return miss.length ? `answer missing "${miss.join('", "')}"` : null; },
  notContains: (words, t) => { const hit = words.filter((w) => lower(t.reply).includes(lower(w))); return hit.length ? `answer contains "${hit.join('", "')}"` : null; },
  containsAny: (words, t) => (words.some((w) => lower(t.reply).includes(lower(w))) ? null : `answer has none of "${words.join('", "')}"`),
  containsAnyWord: (words, t) => (words.some((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'iu').test(t.reply)) ? null : `answer has none of the words ${words.join(', ')}`),
  guards: (want, t) => { const miss = want.filter((g) => !t.guards.includes(g)); return miss.length ? `guardrail ${miss.join(', ')} did not fire (fired: ${t.guards.join(', ') || 'none'})` : null; },
  noGuards: (on, t) => (on && t.guards.length ? `unexpected guardrail: ${t.guards.join(', ')}` : null),
  maxRounds: (n, t) => (t.rounds > n ? `${t.rounds} LLM rounds (max ${n})` : null),
  maxSeconds: (n, t) => (t.ms / 1000 > n ? `${(t.ms / 1000).toFixed(1)} s (max ${n})` : null),
  // every € amount in the answer must appear in a tool result or in what the customer said
  noInventedPrices: (on, t) => {
    if (!on) return null;
    const invented = findInventedPrices(t.rawReply ?? t.reply, t.sourceText);
    return invented.length ? `price(s) not from any tool: €${invented.map((p) => p.value).join(', €')}` : null;
  },

};

async function runCase(c) {
  const customer = c.customer ? await findById(c.customer) : null;

  // UNIT case: test the output guard directly with a made-up answer (no LLM call, instant)
  if (c.unit === 'output') {
    const go = guardOutput(c.answer, { customer, sources: c.sources || '' });
    const t = { reply: go.text, calls: [], tools: [], rounds: 0, ms: 0, tokens: 0, sourceText: c.sources || '', guards: go.issues.map((i) => i.name) };
    return finish(c, t, null, []);
  }

  const history = [...(c.history || []), { role: 'user', content: c.say }];
  const cards = [];
  let reply = '', error = null, data;
  try {
    ({ reply, trace: data } = await runTurn({
      channel: 'eval', history, customer, conversationId: 'c_eval',
      remember: false,                  // tests never write memory
      memory: c.memory ?? null,         // tests never read real memory files; a case can provide one
      send: (e) => { if (e.ui) cards.push(e.ui.type); },
      traceOptions: { save: false, keepFull: true },
    }));
  } catch (e) {
    error = e.message;
  }
  data ??= { steps: [], tokens: { total: 0 }, ms: 0 };
  const calls = data.steps.filter((s) => s.type === 'tool');
  const t = {
    reply: reply || '',
    // price check runs on the answer BEFORE the guard fixed it, so we see whether the LLM invented one
    rawReply: data.steps.filter((s) => s.type === 'llm').at(-1)?.content,
    calls,
    tools: calls.map((s) => s.name),
    rounds: data.steps.filter((s) => s.type === 'llm').length,
    ms: data.ms,
    tokens: data.tokens.total,
    guards: data.guards || [],
    sourceText: [c.say, ...(c.history || []).map((m) => m.content), ...calls.map((s) => JSON.stringify(s.result))].join(' '),
  };
  return finish(c, t, error, cards);
}

function finish(c, t, error, cards) {
  const failures = error ? [`error: ${error}`] : Object.entries(c.expect || {})
    .map(([name, want]) => (CHECKS[name] ? CHECKS[name](want, t) : `unknown check "${name}"`))
    .filter(Boolean);
  return { id: c.id, group: c.group, pass: failures.length === 0, failures, tools: t.tools, guards: t.guards, rounds: t.rounds, ms: t.ms, tokens: t.tokens, cards, reply: t.reply };
}

// ---------- main ----------
const all = JSON.parse(await readFile(path.join(ROOT, 'evals/cases.json'), 'utf8'));
const cases = all.filter((c) => !filter || lower(c.id).includes(filter) || lower(c.group).includes(filter));
if (!cases.length) { console.log(`No cases match "${filter}".`); process.exit(1); }

console.log(`\nRunning ${cases.length} case(s)${repeat > 1 ? ` × ${repeat}` : ''} against ${process.env.OPENAI_MODEL || 'default model'}…\n`);
const results = [];
for (const c of cases) {
  for (let i = 0; i < repeat; i++) {
    const r = await runCase(c);
    results.push(r);
    const mark = r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const what = (r.tools.length ? r.tools.join(' → ') : 'no tools') + (r.guards?.length ? `  🛡️ ${r.guards.join(', ')}` : '');
    console.log(`  ${mark} ${r.id.padEnd(28)} ${what.padEnd(36)} ${(r.ms / 1000).toFixed(1).padStart(5)} s`);
    for (const f of r.failures) console.log(`      ↳ ${f}`);
  }
}

const passed = results.filter((r) => r.pass).length;
const avg = results.reduce((s, r) => s + r.ms, 0) / results.length / 1000;
const tokens = results.reduce((s, r) => s + (r.tokens || 0), 0);
console.log(`\n  ${passed} / ${results.length} passed  ·  avg ${avg.toFixed(1)} s  ·  ${tokens.toLocaleString()} tokens\n`);

await mkdir(path.join(ROOT, 'evals/reports'), { recursive: true });
const file = path.join(ROOT, 'evals/reports', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}.json`);
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), model: process.env.OPENAI_MODEL, filter: filter || null, passed, total: results.length, results }, null, 2));
console.log(`  Report saved: evals/reports/${path.basename(file)}\n`);
process.exit(passed === results.length ? 0 : 1);
