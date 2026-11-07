// Trace recorder — "observability" for the agent.
// One trace = one customer turn. It records every LLM round and every tool call,
// then appends one JSON line to server/logs/YYYY-MM-DD.jsonl.
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs');
const recent = []; // last 200 traces in memory for the log viewer
const MAX_RECENT = 200;

const short = (v, n = 2000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
};

// options: save=false → don't write to logs (used by tests); keepFull=true → keep full tool results
export function createTrace({ channel, customer, input, conversationId = null, save = true, keepFull = false }) {
  const started = Date.now();
  const trace = {
    id: `t_${started.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: new Date(started).toISOString(),
    channel,                                   // 'text' | 'voice'
    conversation: conversationId,              // groups the turns of one chat
    customer: customer ? `${customer.id} ${customer.firstName}` : 'guest',
    input,                                     // what the customer said/typed
    steps: [],                                 // llm + tool steps in order
    tokens: { prompt: 0, completion: 0, total: 0 },
    output: null,
    error: null,
    ms: 0,
  };

  return {
    id: trace.id,
    /** one call to the LLM */
    llm({ round, ms, toolCalls, content, usage }) {
      trace.steps.push({
        type: 'llm', round, ms,
        decision: toolCalls?.length ? `tool: ${toolCalls.map((c) => c.name).join(', ')}` : 'answer',
        content: keepFull ? content : short(content, 600),
        usage: usage || null,
      });
      if (usage) {
        trace.tokens.prompt += usage.prompt_tokens || 0;
        trace.tokens.completion += usage.completion_tokens || 0;
        trace.tokens.total += usage.total_tokens || 0;
      }
    },
    /** one tool run */
    tool({ name, args, ms, result, error }) {
      trace.steps.push({ type: 'tool', name, args, ms, result: keepFull ? result : short(result), error: error || null });
    },
    /** a guardrail fired (blocked, cut or removed something) */
    guard({ name, detail }) {
      trace.steps.push({ type: 'guard', name, detail });
      (trace.guards ??= []).push(name);
    },
    /** the recorded data so far (used by the test runner) */
    snapshot() { return trace; },
    /** finish the turn and save it */
    async end({ output, error } = {}) {
      trace.output = output ?? null;
      trace.error = error ?? null;
      trace.ms = Date.now() - started;
      if (!save) return trace;
      recent.unshift(trace);
      if (recent.length > MAX_RECENT) recent.pop();
      try {
        await mkdir(LOG_DIR, { recursive: true });
        await appendFile(path.join(LOG_DIR, `${trace.at.slice(0, 10)}.jsonl`), JSON.stringify(trace) + '\n');
      } catch (e) {
        console.error('[trace] could not write log', e.message);
      }
      const tools = trace.steps.filter((s) => s.type === 'tool').map((s) => s.name).join(', ') || 'no tools';
      console.log(`[trace] ${trace.channel} "${short(trace.input, 50)}" → ${tools} · ${trace.ms} ms · ${trace.tokens.total} tokens`);
    },
  };
}

/** For the log viewer: recent traces (from memory, else today's log file) */
export async function listTraces(limit = 100) {
  if (recent.length) return recent.slice(0, limit);
  try {
    const files = (await readdir(LOG_DIR)).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out = [];
    for (const f of files) {
      const lines = (await readFile(path.join(LOG_DIR, f), 'utf8')).trim().split('\n').reverse();
      for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} if (out.length >= limit) return out; }
    }
    return out;
  } catch {
    return [];
  }
}
