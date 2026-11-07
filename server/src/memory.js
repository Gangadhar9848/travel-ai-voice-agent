// Memory — what the agent remembers about a MEMBER between visits.
// One file per member: server/data/memory/<customerId>.json
//   { customer, preferences: [...], conversations: [{ id, date, updated, summary, outcome }] }
// After every reply, luna updates the summary of the current conversation (in the background).
// On the next visit, the last few summaries are added to the rulebook (see prompts.js).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChat } from './llm.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/memory');
const KEEP_CONVERSATIONS = 5;   // stored per member
const SHOW_CONVERSATIONS = 3;   // given to the LLM on the next visit
const RETENTION_DAYS = Number(process.env.MEMORY_RETENTION_DAYS || 365);

const fileFor = (customerId) => path.join(DIR, `${String(customerId).replace(/[^\w-]/g, '')}.json`);
const empty = (customerId) => ({ customer: customerId, preferences: [], conversations: [] });

/** Load a member's memory (old conversations past the retention period are dropped) */
export async function loadMemory(customerId) {
  if (!customerId) return null;
  try {
    const mem = JSON.parse(await readFile(fileFor(customerId), 'utf8'));
    const cutoff = Date.now() - RETENTION_DAYS * 864e5;
    mem.conversations = (mem.conversations || []).filter((c) => new Date(c.updated || c.date).getTime() >= cutoff);
    return mem;
  } catch {
    return null; // no memory yet
  }
}

async function saveMemory(mem) {
  await mkdir(DIR, { recursive: true });
  await writeFile(fileFor(mem.customer), JSON.stringify(mem, null, 2) + '\n');
}

/** "Forget me": delete a member's memory file */
export async function deleteMemory(customerId) {
  await rm(fileFor(customerId), { force: true });
}

/** Text for the rulebook: previous conversations (not the current one) + preferences */
export function memoryForPrompt(mem, currentConversationId) {
  if (!mem) return '';
  const past = mem.conversations
    .filter((c) => c.id !== currentConversationId)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, SHOW_CONVERSATIONS);
  if (!past.length && !mem.preferences?.length) return '';
  let txt = '';
  if (mem.preferences?.length) txt += `- Known preferences: ${mem.preferences.join(', ')}\n`;
  for (const c of past) txt += `- ${c.date}: ${c.summary} (outcome: ${c.outcome})\n`;
  return txt.trim();
}

// ---------- update after a reply ----------
const queues = new Map(); // one update at a time per member, so writes never clash

/**
 * Ask luna to update this conversation's summary. Runs in the background — never blocks the reply.
 * @param history the cleaned conversation (after the input guard)
 * @param reply   the final, guarded answer
 */
export function updateMemory({ customer, conversationId, history, reply }) {
  if (!customer?.id || !conversationId) return Promise.resolve(); // guests: no memory
  const prev = queues.get(customer.id) || Promise.resolve();
  const job = prev.then(() => doUpdate({ customer, conversationId, history, reply })).catch((e) => console.error('[memory]', e.message));
  queues.set(customer.id, job);
  return job;
}

async function doUpdate({ customer, conversationId, history, reply }) {
  const mem = (await loadMemory(customer.id)) || empty(customer.id);
  const current = mem.conversations.find((c) => c.id === conversationId);
  const recent = [...history.slice(-6), { role: 'assistant', content: reply }]
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${String(m.content).slice(0, 600)}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: `You keep a short memory for a holiday travel agent about one customer.
Return ONLY JSON: {"summary": "...", "outcome": "...", "preferences": ["..."]}
- summary: max 60 words, third person, facts only: what they looked for, who travels, when, from where,
  destinations/hotels/prices they liked, what is still open. Keep earlier facts from the previous summary unless contradicted.
- outcome: one of "browsing", "destination chosen", "package chosen", "reserved", "no interest".
- preferences: max 8 short items that will still be true next time (e.g. "beach", "breakfast included", "budget ~€500").
  Merge with the existing list; drop items the customer contradicted.
Never include card numbers, passwords or other sensitive data.`,
    },
    {
      role: 'user',
      content: `Previous summary of this conversation: ${current?.summary || '(none — new conversation)'}
Existing preferences: ${JSON.stringify(mem.preferences || [])}

Latest messages:
${recent}`,
    },
  ];

  const { content } = await streamChat(messages, {}); // no tools — just write the summary
  const json = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());

  const now = new Date().toISOString();
  const entry = { id: conversationId, date: current?.date || now.slice(0, 10), updated: now, summary: String(json.summary || '').slice(0, 600), outcome: json.outcome || 'browsing' };
  mem.conversations = [entry, ...mem.conversations.filter((c) => c.id !== conversationId)]
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, KEEP_CONVERSATIONS);
  if (Array.isArray(json.preferences)) mem.preferences = json.preferences.map(String).slice(0, 8);
  await saveMemory(mem);
  console.log(`[memory] ${customer.id} ${conversationId}: "${entry.summary.slice(0, 80)}…" (${entry.outcome})`);
}
