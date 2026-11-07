import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { llmLabel } from './llm.js';
import { runAgent } from './agent.js';
import { attachVoice } from './voice.js';
import { listTraces } from './trace.js';
import { runTurn } from './turn.js';
import { loadMemory, deleteMemory } from './memory.js';
import { getQuiz } from './data.js';
import { buildSystemPrompt, listPromptFiles } from './prompts.js';
import { findCustomer, findById, publicProfile } from './customers.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT ?? 20);

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, llm: llmLabel(), prompts: await listPromptFiles() });
});

// Debug: see the exact system prompt the LLM receives (?id=C00001 for a member)
app.get('/api/system-prompt', async (req, res) => {
  const customer = await findById(req.query.id);
  res.type('text/plain').send(await buildSystemPrompt({ customer }));
});

// Mood quiz questions (for the client-side quiz button)
app.get('/api/quiz', async (_req, res) => res.json(await getQuiz()));

// Agent traces for the log viewer (#log)
app.get('/api/logs', async (req, res) => res.json(await listTraces(Number(req.query.limit) || 100)));

// MEMORY: view or erase what the agent remembers about a member ("forget me")
app.get('/api/memory/:id', async (req, res) => res.json((await loadMemory(req.params.id)) || { customer: req.params.id, preferences: [], conversations: [] }));
app.delete('/api/memory/:id', async (req, res) => { await deleteMemory(req.params.id); res.json({ deleted: true }); });

// POST /api/identify { identifier: email | customer ID }
app.post('/api/identify', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  if (!identifier) return res.status(400).json({ found: false, error: 'Enter your email or customer ID.' });
  const customer = await findCustomer(identifier);
  if (!customer) return res.status(404).json({ found: false });
  res.json({ found: true, customer: publicProfile(customer) });
});

// POST /api/chat  { messages: [{role:'user'|'assistant', content}], customerId?: string }
// Streams Server-Sent Events: {token} text · {status} progress · {ui} cards · {done} · {error}
app.post('/api/chat', async (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const history = incoming
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-HISTORY_LIMIT);

  if (!history.length || history.at(-1).role !== 'user') {
    return res.status(400).json({ error: 'Last message must be from the user.' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  try {
    const customer = await findById(req.body?.customerId); // null → guest
    await runTurn({
      channel: 'text', mode: 'text', history, customer, send, signal: abort.signal,
      conversationId: typeof req.body?.conversationId === 'string' ? req.body.conversationId.slice(0, 40) : undefined,
      rateKey: req.body?.customerId || req.ip,          // rate limit per member, or per browser for guests
    });
    send({ done: true });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[chat]', err.message);
      send({ error: err.message });
    }
  } finally {
    res.end();
  }
});

const PORT = Number(process.env.PORT ?? 3001);
const server = app.listen(PORT, () => {
  console.log(`Travel agent API on http://localhost:${PORT}  (LLM: ${llmLabel()})`);
});
attachVoice(server);
