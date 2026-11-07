import { useEffect, useState } from 'react';

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pretty = (v) => {
  if (v == null) return '';
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
};

export default function LogViewer() {
  const [traces, setTraces] = useState([]);
  const [selected, setSelected] = useState(null);
  const [auto, setAuto] = useState(true);

  async function load() {
    try {
      const r = await fetch('/api/logs?limit=100');
      const list = await r.json();
      setTraces(list);
      setSelected((s) => (s ? list.find((t) => t.id === s.id) || s : list[0] || null));
    } catch { /* server down */ }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div className="logs">
      <header className="logs-head">
        <div>
          <h1>Agent log</h1>
          <p className="muted">Every turn: what the customer said, each LLM round, each tool call, the answer.</p>
        </div>
        <div className="actions">
          <label className="muted"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh</label>
          <button className="ghost" onClick={load}>Refresh</button>
          <a className="ghost" href="#">← Back to chat</a>
        </div>
      </header>

      <div className="logs-body">
        <ul className="logs-list">
          {traces.length === 0 && <li className="muted empty">No turns yet. Send a message in the chat, then come back.</li>}
          {traces.map((t) => {
            const tools = t.steps.filter((s) => s.type === 'tool');
            return (
              <li key={t.id} className={`${selected?.id === t.id ? 'on' : ''} ${selected?.conversation && t.conversation === selected.conversation && selected.id !== t.id ? 'same-conv' : ''}`} onClick={() => setSelected(t)}>
                <div className="row1">
                  <span className={`ch ch-${t.channel}`}>{t.channel === 'voice' ? '🎤 voice' : '⌨️ text'}</span>
                  <span className="muted">{time(t.at)}</span>
                  {t.error && <span className="badge warn">error</span>}
                  {t.guards?.length > 0 && <span className="badge warn">🛡️ {t.guards.length}</span>}
                </div>
                <div className="in">{t.input}</div>
                <div className="row3 muted">
                  {tools.length ? tools.map((s) => s.name).join(' → ') : 'no tools'} · {fmtMs(t.ms)} · {t.tokens.total || '–'} tok
                </div>
              </li>
            );
          })}
        </ul>

        {selected && (
          <section className="logs-detail">
            <div className="kv">
              <span>Customer</span><b>{selected.customer}</b>
              <span>Channel</span><b>{selected.channel}</b>
              <span>Conversation</span><b>{selected.conversation || '–'}{selected.conversation ? ` (${traces.filter((x) => x.conversation === selected.conversation).length} turns)` : ''}</b>
              <span>Total time</span><b>{fmtMs(selected.ms)}</b>
              <span>Tokens</span><b>{selected.tokens.total} ({selected.tokens.prompt} in / {selected.tokens.completion} out)</b>
            </div>

            <h3>Customer said</h3>
            <div className="quote">{selected.input}</div>

            <h3>Steps</h3>
            <ol className="steps">
              {selected.steps.map((s, i) => (
                <li key={i} className={`step ${s.type}`}>
                  {s.type === 'guard' ? (
                    <>
                      <div className="step-head"><b>🛡️ Guardrail: {s.name}</b></div>
                      <div className="muted small">{s.detail}</div>
                    </>
                  ) : s.type === 'llm' ? (
                    <>
                      <div className="step-head"><b>LLM round {s.round}</b><span className="muted">{fmtMs(s.ms)}{s.usage ? ` · ${s.usage.total_tokens} tok` : ''}</span></div>
                      <div>Decision: <code>{s.decision}</code></div>
                      {s.content && <div className="muted small">“{s.content}”</div>}
                    </>
                  ) : (
                    <>
                      <div className="step-head"><b>Tool: {s.name}</b><span className="muted">{fmtMs(s.ms)}</span></div>
                      <details>
                        <summary>Arguments</summary>
                        <pre>{pretty(s.args)}</pre>
                      </details>
                      <details>
                        <summary>Result{s.error ? ' (error)' : ''}</summary>
                        <pre>{pretty(s.result)}</pre>
                      </details>
                    </>
                  )}
                </li>
              ))}
            </ol>

            <h3>{selected.error ? 'Error' : 'Answer'}</h3>
            <div className={`quote ${selected.error ? 'err' : ''}`}>{selected.error || selected.output}</div>
          </section>
        )}
      </div>
    </div>
  );
}
