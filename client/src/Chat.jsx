import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { streamChat, getQuiz } from './api.js';
import QuizCard, { answerIcon } from './cards/QuizCard.jsx';
import MatchCards from './cards/MatchCards.jsx';
import PackageCards from './cards/PackageCards.jsx';
import ActivityCards from './cards/ActivityCards.jsx';
import { startVoice } from './voice.js';

const AIRPORTS = { ARN: 'Stockholm Arlanda', CPH: 'Copenhagen', OSL: 'Oslo' };
const TIER = (t) => (t && t !== 'Member' ? `${t} member` : 'Member');
const QUIZ_CHIP = '✨ Help me choose — take the mood quiz';

function greeting(user) {
  if (user.type === 'member') {
    const c = user.customer;
    const from = AIRPORTS[c.homeAirport] || c.homeAirport;
    return `Hej ${c.firstName}! 👋 Welcome back — great to see you${c.tier && c.tier !== 'Member' ? `, **${c.tier}** member` : ''}. Shall we plan your next holiday${from ? ` from ${from}` : ''}? Tell me where you're dreaming of, or how you'd like to *feel* on this trip.`;
  }
  return "Hej! 👋 I'm your **Holiday Assistant**. Which airport would you like to fly from — and where are you dreaming of going? You can also just tell me how you'd like to *feel* on this trip.";
}

const SUGGESTIONS = {
  member: [QUIZ_CHIP, 'Something like my last trip', 'Autumn sun in October', 'Weekend city break'],
  guest: [QUIZ_CHIP, 'Sun & beach from Stockholm', 'Family trip with 2 kids from Oslo', 'Romantic getaway for two'],
};

// Message = { role, parts: [{type:'text', text} | {type:'ui', ui, answered?}], content? (user: text sent to LLM) }
const textMsg = (role, text, content) => ({ role, parts: [{ type: 'text', text }], content });

/** Flatten the chat into plain text for the LLM (cards → their short note). */
function toHistory(messages) {
  return messages.slice(1).map((m) => ({
    role: m.role,
    content:
      m.content ??
      m.parts.map((p) => (p.type === 'text' ? p.text : `\n[${p.ui.note}]\n`)).join('').trim(),
  })).filter((m) => m.content);
}

export default function Chat({ user, onExit }) {
  const first = textMsg('assistant', greeting(user));
  const [messages, setMessages] = useState([first]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [voice, setVoice] = useState(null); // null | { state: 'connecting'|'live', speaking, status }
  const voiceRef = useRef(null);
  const micRef = useRef(null);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const customerId = user.type === 'member' ? user.customer.id : undefined;
  // one ID per chat — the server groups turns and keeps one memory summary per conversation
  const newConversationId = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [conversationId, setConversationId] = useState(newConversationId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  // Append to the last (assistant) message
  const patchLast = (fn) =>
    setMessages((prev) => {
      const next = [...prev];
      const last = { ...next.at(-1), parts: [...next.at(-1).parts] };
      fn(last.parts);
      next[next.length - 1] = last;
      return next;
    });

  async function send(display, content, base = messagesRef.current) {
    const shown = display.trim();
    if (!shown || busy) return;
    if (shown === QUIZ_CHIP) return openQuiz();

    setError('');
    setInput('');
    const history = [...base, textMsg('user', shown, content)];
    setMessages([...history, { role: 'assistant', parts: [] }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(toHistory(history), {
        conversationId,
        customerId,
        signal: controller.signal,
        onEvent: (e) => {
          if ('status' in e) setStatus(e.status);
          if (e.token) {
            setStatus(null);
            patchLast((parts) => {
              const last = parts.at(-1);
              if (last?.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + e.token };
              else parts.push({ type: 'text', text: e.token });
            });
          }
          if (e.ui) patchLast((parts) => parts.push({ type: 'ui', ui: e.ui }));
          // GUARDRAIL: the server corrected the answer (e.g. removed an invented price)
          if (e.replace) patchLast((parts) => {
            for (let i = parts.length - 1; i >= 0; i--) {
              if (parts[i].type === 'text' && parts[i].text.includes(e.replace.from)) {
                parts[i] = { ...parts[i], text: parts[i].text.replace(e.replace.from, e.replace.to) };
                return;
              }
            }
          });
          // GUARDRAIL: hide a card number in the customer's own bubble
          if (e.replaceUser) setMessages((prev) => {
            const next = [...prev];
            const i = next.length - 2; // the user message just before the streaming answer
            if (next[i]?.role === 'user') next[i] = { ...next[i], parts: [{ type: 'text', text: e.replaceUser }], content: e.replaceUser };
            return next;
          });
        },
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setMessages((prev) => (prev.at(-1).parts.length ? prev : prev.slice(0, -1)));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
    }
  }

  // Quiz without an LLM round-trip
  async function openQuiz() {
    try {
      const quiz = await getQuiz();
      setMessages((prev) => [
        ...prev,
        textMsg('user', 'Help me choose — take the mood quiz'),
        { role: 'assistant', parts: [
          { type: 'text', text: "Let's find your perfect match! Three quick questions — just go with your gut. 👇" },
          { type: 'ui', ui: { type: 'quiz', data: quiz, note: 'Mood quiz shown to the customer.' } },
        ] },
      ]);
    } catch (e) {
      setError(e.message);
    }
  }

  function quizDone(msgIndex, partIndex, answers) {
    const next = [...messagesRef.current];
    const m = { ...next[msgIndex], parts: [...next[msgIndex].parts] };
    m.parts[partIndex] = { ...m.parts[partIndex], answered: answers };
    next[msgIndex] = m;
    const display = answers.map((a) => `${answerIcon(a.question_id, a.answer_id)} ${a.text}`).join(' · ');
    const content = `My mood quiz answers: ${answers.map((a) => `${a.question_id}=${a.answer_id} (${a.text})`).join(', ')}`;
    send(display, content, next);
  }

  // ---------- Voice (GPT-Live-1) ----------
  // Add streamed voice text to the last bubble of that role, or start a new bubble
  function appendVoiceText(role, delta) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      if (last?.role === role && last.voice) {
        const parts = [...last.parts];
        const lp = parts.at(-1);
        if (lp?.type === 'text') parts[parts.length - 1] = { ...lp, text: lp.text + delta };
        else parts.push({ type: 'text', text: delta.trimStart() });
        next[next.length - 1] = { ...last, parts };
      } else {
        next.push({ role, voice: true, parts: [{ type: 'text', text: delta.trimStart() }] });
      }
      return next;
    });
  }
  function appendVoiceUi(ui) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      if (last?.role === 'assistant' && last.voice) next[next.length - 1] = { ...last, parts: [...last.parts, { type: 'ui', ui }] };
      else next.push({ role: 'assistant', voice: true, parts: [{ type: 'ui', ui }] });
      return next;
    });
  }

  function onVoiceEvent(e) {
    switch (e.type) {
      case 'level': micRef.current?.style.setProperty('--lvl', e.level.toFixed(2)); break;
      case 'ready': setVoice((v) => v && { ...v, state: 'live' }); break;
      case 'speaking': setVoice((v) => v && { ...v, speaking: e.on }); break;
      case 'status': setVoice((v) => v && { ...v, status: e.status }); break;
      case 'user_transcript': appendVoiceText('user', e.delta); break;
      case 'assistant_transcript': appendVoiceText('assistant', e.delta); break;
      case 'ui': appendVoiceUi(e.ui); break;
      case 'error': setError(e.message); break;
      case 'closed': voiceRef.current = null; setVoice(null); break;
    }
  }

  async function toggleVoice() {
    if (voiceRef.current) { voiceRef.current.stop(); voiceRef.current = null; setVoice(null); return; }
    setError('');
    setVoice({ state: 'connecting' });
    try {
      voiceRef.current = await startVoice({ customerId, conversationId, history: toHistory(messagesRef.current), onEvent: onVoiceEvent });
    } catch (e) {
      setVoice(null);
      setError(e.name === 'NotAllowedError' ? 'Microphone access was blocked — allow it in the browser and try again.' : e.message);
    }
  }
  useEffect(() => () => voiceRef.current?.stop(), []);

  function newChat() {
    voiceRef.current?.stop(); voiceRef.current = null; setVoice(null);
    abortRef.current?.abort();
    setMessages([first]);
    setConversationId(newConversationId());
    setError('');
  }

  function exit() {
    voiceRef.current?.stop();
    abortRef.current?.abort();
    onExit();
  }

  const renderPart = (p, mi, pi) => {
    if (p.type === 'text') return <Markdown key={pi}>{p.text}</Markdown>;
    const { type, data } = p.ui;
    if (type === 'quiz') return <QuizCard key={pi} quiz={data} answered={p.answered} disabled={busy} onDone={(a) => quizDone(mi, pi, a)} />;
    if (type === 'matches') return <MatchCards key={pi} data={data} disabled={busy} onAction={(t) => send(t)} />;
    if (type === 'packages') return <PackageCards key={pi} data={data} disabled={busy} onAction={(t) => send(t)} />;
    if (type === 'activities') return <ActivityCards key={pi} data={data} />;
    return null;
  };

  const lastIsStreaming = busy && messages.at(-1).role === 'assistant';

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">✈</span>
          <div>
            <h1>Holiday Assistant</h1>
            {user.type === 'member' ? (
              <p><span className={`tier tier-${user.customer.tier.toLowerCase()}`}>{TIER(user.customer.tier)}</span> {user.customer.firstName}</p>
            ) : (
              <p>Guest</p>
            )}
          </div>
        </div>
        <div className="actions">
          <a className="ghost" href="#log" target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>Agent log</a>
          <button className="ghost" onClick={newChat}>New chat</button>
          <button className="ghost" onClick={exit}>{user.type === 'member' ? 'Log out' : 'Log in'}</button>
        </div>
      </header>

      <main className="chat">
        {messages.map((m, mi) => {
          const hasUi = m.parts.some((p) => p.type === 'ui');
          const streamingThis = lastIsStreaming && mi === messages.length - 1;
          return (
            <div key={mi} className={`msg ${m.role} ${hasUi ? 'wide' : ''} ${m.voice ? 'voice' : ''}`}>
              <div className="bubble">
                {m.parts.map((p, pi) => renderPart(p, mi, pi))}
                {streamingThis && (status || !m.parts.length) && (
                  <div className="status">
                    <span className="typing"><i /><i /><i /></span>
                    {status && <span>{status}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {messages.length === 1 && (
          <div className="suggestions">
            {SUGGESTIONS[user.type].map((s) => (
              <button key={s} className={s === QUIZ_CHIP ? 'primary' : ''} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {error && <div className="error">⚠ {error}</div>}
        <div ref={endRef} />
      </main>

      {voice && (
        <div className={`voice-bar ${voice.speaking ? 'speaking' : ''}`}>
          <span className="voice-dot" />
          {voice.state === 'connecting' ? 'Connecting to voice…'
            : voice.status ? voice.status
            : voice.speaking ? 'Speaking… (you can interrupt)'
            : 'Listening — just talk'}
          <button className="link small" onClick={toggleVoice}>End voice</button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <button
          type="button"
          ref={micRef}
          className={`mic ${voice ? 'on' : ''}`}
          onClick={toggleVoice}
          title={voice ? 'End voice' : 'Talk to the assistant'}
          aria-label={voice ? 'End voice' : 'Start voice'}
        >
          {voice ? '■' : '🎤'}
        </button>
        <textarea
          value={input}
          placeholder="Type your message…"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" disabled={!input.trim()}>Send</button>
        )}
      </form>
    </div>
  );
}
