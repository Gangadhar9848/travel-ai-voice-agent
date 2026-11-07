// Agent loop: LLM ↔ tools until the LLM answers in plain text.
import { streamChat } from './llm.js';
import { buildSystemPrompt } from './prompts.js';
import { TOOL_DEFS, runTool, toolStatus } from './tools/index.js';
import { getPackage } from './tools/inventory.js';
import { LIMITS } from './guardrails.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * If the reply contains a package summary ("… (package P00594)"), attach GetYourGuide
 * activities for that destination and trip dates — so it never depends on the LLM remembering.
 */
export async function autoActivities(text, customer, send) {
  const pkgId = text.match(/package\s+(P\d{4,})/i)?.[1];
  if (!pkgId) return;
  const pkg = await getPackage(pkgId);
  if (!pkg) return;

  // "2 Oct – 6 Oct 2026" / "2 October – 6 October 2026"
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*[–-]\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  const args = { destination: pkg.destinationId };
  if (m) {
    const [, d1, m1, d2, m2, y] = m;
    const mo1 = MONTHS[m1.toLowerCase()], mo2 = MONTHS[m2.toLowerCase()];
    if (mo1 && mo2) {
      args.date_from = iso(mo1 > mo2 ? Number(y) - 1 : y, mo1, d1);
      args.date_to = iso(y, mo2, d2);
    }
  }

  send({ status: toolStatus('find_activities') });
  const out = await runTool('find_activities', args, { customer });
  send({ status: null });
  console.log(`[auto] find_activities(${JSON.stringify(args)}) → ${out.ui ? out.result.results.length + ' activities' : 'none'}`);
  if (!out.ui) return;
  send({ token: `\n\n🎟️ **While you're in ${pkg.destination}** — top-rated things to do (booked separately on GetYourGuide):` });
  send({ ui: out.ui });
}

const MAX_STEPS = 6;

/**
 * send(obj) streams SSE events to the browser:
 *   { token } text chunk · { status } "Searching…" · { ui } cards · { done } · { error }
 */
// toolResults (optional array): every tool result of this turn is pushed here (the output guard needs them)
export async function runAgent({ history, customer, send, signal, extraSystem, trace, toolResults = [], conversationId, memory }) {
  let system = await buildSystemPrompt({ customer, conversationId, memory });
  if (extraSystem) system += `\n\n---\n\n${extraSystem}`;
  const convo = [{ role: 'system', content: system }, ...history];

  let activitiesShown = false;
  const seenCalls = new Set();   // LOOP GUARD: same tool + same arguments
  let toolCount = 0;             // LOOP GUARD: tool calls this turn
  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = Date.now();
    const { content, toolCalls, usage } = await streamChat(convo, {
      tools: TOOL_DEFS,
      onToken: (t) => send({ token: t }),
      signal,
    });
    trace?.llm({ round: step + 1, ms: Date.now() - t0, toolCalls, content, usage });
    if (!toolCalls.length) {
      if (!activitiesShown) await autoActivities(content, customer, send).catch((e) => console.error('[auto]', e.message));
      return content;
    }
    if (toolCalls.some((c) => c.name === 'find_activities')) activitiesShown = true;

    convo.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });

    for (const call of toolCalls) {
      send({ status: toolStatus(call.name) });
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* bad JSON → empty args */ }

      // ---- LOOP GUARD ----
      const key = `${call.name}:${JSON.stringify(args)}`;
      if (seenCalls.has(key) || toolCount >= LIMITS.maxToolCalls) {
        const why = seenCalls.has(key)
          ? 'You already called this tool with the same arguments. Use that earlier result.'
          : `Tool limit (${LIMITS.maxToolCalls}) reached for this message. Answer now with the information you already have.`;
        trace?.guard({ name: seenCalls.has(key) ? 'repeated_tool_call' : 'tool_limit', detail: `${call.name} ${JSON.stringify(args)}` });
        console.log(`[guard] blocked ${call.name}: ${why}`);
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: why }) });
        continue;
      }
      seenCalls.add(key);
      toolCount++;

      let out;
      const t1 = Date.now();
      try {
        out = await runTool(call.name, args, { customer });
      } catch (e) {
        out = { result: { error: e.message } };
      }
      toolResults.push(out.result);
      trace?.tool({ name: call.name, args, ms: Date.now() - t1, result: out.result, error: out.result?.error });
      console.log(`[tool] ${call.name}(${JSON.stringify(args)}) → ${out.result?.error ? 'ERROR ' + out.result.error : 'ok'}`);
      if (out.ui) send({ ui: out.ui });
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
    }
    send({ status: null });
  }
  send({ token: '\n\n_(I had to stop there — could you rephrase or narrow down your request?)_' });
  return "Sorry, I couldn't finish that. Could you say it a bit differently?";
}
