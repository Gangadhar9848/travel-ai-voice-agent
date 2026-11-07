// One customer turn, the same for text chat, voice and the test runner:
//   input guard → runAgent (brain + loop guard) → output guard, all recorded in a trace.
import { runAgent } from './agent.js';
import { guardInput, guardOutput } from './guardrails.js';
import { createTrace } from './trace.js';
import { loadMemory, memoryForPrompt, updateMemory } from './memory.js';

/**
 * @param channel  'text' | 'voice' | 'eval'
 * @param mode     'text' | 'voice' — how a corrected answer is worded
 * @param send     events for the browser: {token} {ui} {status} {replace:{from,to}} {replaceUser}
 * @param traceOptions  passed to createTrace (tests use { save:false, keepFull:true })
 * @returns {{ reply: string, trace: object }}
 */
// conversationId: one per chat (new on "New chat"); remember=false → don't update memory (tests)
// memory: test override for the stored memory
export async function runTurn({ channel, mode = 'text', history, customer, conversationId, send = () => {}, signal, extraSystem, rateKey, traceOptions = {}, remember = true, memory }) {
  // ---- INPUT GUARD ----
  const gi = guardInput(history, { rateKey });
  const trace = createTrace({ channel, customer, input: gi.lastUser, conversationId, ...traceOptions });
  for (const i of gi.issues) trace.guard(i);

  if (gi.blocked) {
    send({ token: gi.blocked });
    return { reply: gi.blocked, trace: await trace.end({ output: gi.blocked }) };
  }
  if (gi.issues.some((i) => i.name === 'card_number')) send({ replaceUser: gi.lastUser }); // hide the card number in the chat bubble too
  if (gi.notice) send({ token: `${gi.notice}\n\n` });

  try {
    // ---- BRAIN (with loop guard inside) ----
    const toolResults = [];
    const raw = (await runAgent({ history: gi.history, customer, send, signal, extraSystem, trace, toolResults, conversationId, memory })) || '';

    // ---- OUTPUT GUARD ----
    // prices may come from tool results, the conversation, or remembered past conversations
    const mem = memory !== undefined ? memory : customer ? await loadMemory(customer.id) : null;
    const sources = [...toolResults.map((r) => JSON.stringify(r)), ...gi.history.map((m) => m.content), memoryForPrompt(mem, conversationId)].join(' ');
    const go = guardOutput(raw, { customer, sources, mode });
    for (const i of go.issues) { trace.guard(i); console.log(`[guard] ${i.name}: ${i.detail}`); }
    if (go.changed) send({ replace: { from: raw, to: go.text } });

    const reply = gi.notice ? `${gi.notice} ${go.text}` : go.text;
    // MEMORY: update this member's summary in the background (the customer doesn't wait)
    if (remember) updateMemory({ customer, conversationId, history: gi.history, reply: go.text });
    return { reply, trace: await trace.end({ output: reply }) };
  } catch (e) {
    await trace.end({ error: e.message });
    throw e;
  }
}
