// Voice bridge: Browser ⇄ (WebSocket /api/voice) ⇄ this server ⇄ (WebSocket) Azure GPT-Live-1
//
// GPT-Live-1 does the listening + speaking. It runs in CLIENT delegation mode:
// whenever it needs facts, it emits `session.delegation.created`; we then run our normal
// text agent (runAgent: luna + tools) on the conversation so far and send the answer back
// with `session.commentary.append`, which GPT-Live speaks. Cards go straight to the browser.
import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { findById } from './customers.js';
import { runTurn } from './turn.js';

const VOICE_PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts/voice');
const readPrompt = (f) => readFile(path.join(VOICE_PROMPTS, f), 'utf8').catch(() => '');

function liveUrl() {
  const base = (process.env.LIVE_ENDPOINT || '').trim();
  if (!base) throw new Error('LIVE_ENDPOINT is not set in server/.env');
  const host = new URL(base.startsWith('http') ? base : `https://${base}`).host;
  const p = process.env.LIVE_WS_PATH || '/openai/v1/live/sessions';
  const proto = base.startsWith('http://') ? 'ws' : 'wss'; // http:// only for local testing
  return `${proto}://${host}${p}`;
}

let seq = 0;
const eid = (p) => `${p}_${Date.now()}_${++seq}`;

/** Text safe to speak: no markdown, no package ids, max ~450 tokens */
function speakable(text) {
  return String(text || '')
    .replace(/\s*\(?\s*package\s+P\d{4,}\s*\)?/gi, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim()
    .slice(0, 1500);
}

export function attachVoice(server) {
  const wss = new WebSocketServer({ server, path: '/api/voice' });

  wss.on('connection', (browser) => {
    const toBrowser = (obj) => browser.readyState === WebSocket.OPEN && browser.send(JSON.stringify(obj));
    let live = null;
    let customer = null;
    let conversationId;
    const history = [];          // [{role, content}] shared with the text agent
    let userBuf = '';            // current user utterance (from input transcript)
    let botBuf = '';             // current assistant utterance (from output transcript)
    let agentBusy = Promise.resolve();

    const flushUser = () => { if (userBuf.trim()) history.push({ role: 'user', content: userBuf.trim() }); userBuf = ''; };
    const flushBot = () => { if (botBuf.trim()) history.push({ role: 'assistant', content: botBuf.trim() }); botBuf = ''; };
    const toLive = (obj) => live?.readyState === WebSocket.OPEN && live.send(JSON.stringify({ event_id: eid('evt'), ...obj }));

    async function start(msg) {
      customer = await findById(msg.customerId);
      conversationId = typeof msg.conversationId === 'string' ? msg.conversationId.slice(0, 40) : undefined;
      // continue a text conversation that happened before the mic was switched on
      for (const m of msg.history || []) if (m?.content) history.push({ role: m.role, content: m.content });

      let instructions = await readPrompt('live.md');
      instructions += customer
        ? `\n\nThe customer is ${customer.firstName} (${customer.tier} member, flies from ${customer.homeAirport}). Greet them by name.`
        : '\n\nThe customer is a guest (not logged in).';

      const key = process.env.LIVE_API_KEY;
      if (!key) throw new Error('LIVE_API_KEY is not set in server/.env');
      const url = liveUrl();
      console.log(`[voice] connecting ${url}`);
      live = new WebSocket(url, { headers: { Authorization: `Bearer ${key}`, 'api-key': key } });

      live.on('open', () => {
        const audio = process.env.LIVE_VOICE ? { output: { voice: process.env.LIVE_VOICE } } : undefined;
        toLive({
          type: 'session.start',
          session: { model: process.env.LIVE_MODEL || 'gpt-live-1', instructions, ...(audio && { audio }), delegation: { type: 'client' } },
        });
      });

      live.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          console.error(`[voice] Azure refused connection: HTTP ${res.statusCode} ${body.slice(0, 300)}`);
          toBrowser({ type: 'error', message: `Voice service refused the connection (HTTP ${res.statusCode}). ${body.slice(0, 200)}` });
        });
      });
      live.on('error', (e) => { console.error('[voice] live error', e.message); toBrowser({ type: 'error', message: e.message }); });
      live.on('close', (code) => { console.log('[voice] live closed', code); toBrowser({ type: 'closed' }); });

      live.on('message', (raw) => {
        let ev;
        try { ev = JSON.parse(raw.toString()); } catch { return; }
        switch (ev.type) {
          case 'session.started':
            console.log('[voice] session started', ev.session?.id);
            toBrowser({ type: 'ready' });
            // earlier typed chat → quiet context for the voice model
            if (history.length) {
              const recap = history.slice(-8).map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 1500);
              toLive({ type: 'session.thinking.append', delegation_id: null, content: `Conversation so far:\n${recap}` });
            }
            break;
          case 'session.output_audio.delta':
            toBrowser({ type: 'audio', audio: ev.delta, start_ms: ev.start_ms });
            break;
          case 'session.input_transcript.delta':
            if (botBuf) flushBot();
            userBuf += ev.delta;
            toBrowser({ type: 'user_transcript', delta: ev.delta });
            break;
          case 'session.output_transcript.delta':
            if (userBuf) flushUser();
            botBuf += ev.delta;
            toBrowser({ type: 'assistant_transcript', delta: ev.delta });
            break;
          case 'session.delegation.created':
            agentBusy = agentBusy.then(() => delegate(ev.delegation?.id));
            break;
          case 'error':
            console.error('[voice] live event error', ev.error);
            toBrowser({ type: 'error', message: ev.error?.message || 'Voice error' });
            break;
          case 'session.closed':
            console.log('[voice] session closed:', ev.reason);
            toBrowser({ type: 'closed', reason: ev.reason });
            break;
        }
      });
    }

    // GPT-Live asked us to do the thinking → run the normal text agent
    async function delegate(delegationId) {
      await new Promise((r) => setTimeout(r, 400)); // let the user transcript finish
      flushUser();
      flushBot();
      // everything up to the customer's latest words (drop the voice model's "let me check…" fillers after it)
      const lastUser = history.map((m) => m.role).lastIndexOf('user');
      const convo = (lastUser >= 0 ? history.slice(0, lastUser + 1) : [...history]).slice(-20);
      if (!convo.length || convo.at(-1).role !== 'user') convo.push({ role: 'user', content: '(continue with what I just asked)' });

      console.log(`[voice] delegation ${delegationId} → agent (last: "${convo.at(-1).content.slice(0, 80)}")`);
      toBrowser({ type: 'status', status: 'Checking…' });
      try {
        const extraSystem = await readPrompt('backend-voice-mode.md');
        const { reply } = await runTurn({
          channel: 'voice', mode: 'voice', history: convo, customer, conversationId, extraSystem,
          send: (e) => {                                   // cards + progress to the browser; agent text is spoken instead
            if (e.ui) toBrowser({ type: 'ui', ui: e.ui });
            if ('status' in e) toBrowser({ type: 'status', status: e.status });
          },
        });
        const say = speakable(reply) || "I've put the details on your screen.";
        toLive({ type: 'session.commentary.append', delegation_id: delegationId, content: say });
        console.log(`[voice] → speak: "${say.slice(0, 100)}"`);
      } catch (e) {
        console.error('[voice] agent failed', e.message);
        toLive({ type: 'session.commentary.append', delegation_id: delegationId, content: "Sorry, I couldn't look that up just now. Could you try again?" });
      } finally {
        toBrowser({ type: 'status', status: null });
      }
    }

    browser.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.type === 'start') await start(msg);
        else if (msg.type === 'audio') toLive({ type: 'session.input_audio.append', audio: msg.audio });
        else if (msg.type === 'stop') toLive({ type: 'session.close' });
      } catch (e) {
        console.error('[voice]', e.message);
        toBrowser({ type: 'error', message: e.message });
      }
    });

    browser.on('close', () => {
      try { toLive({ type: 'session.close' }); live?.close(); } catch {}
    });
  });

  console.log('Voice bridge on ws://localhost:<port>/api/voice');
}
