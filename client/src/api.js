// Look up a member by email or customer ID.
export async function identify(identifier) {
  const res = await fetch('/api/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.customer;
}

export async function getQuiz() {
  const res = await fetch('/api/quiz');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * POST /api/chat and read the SSE stream.
 * onEvent receives: {token} · {status} · {ui} · {done}
 */
export async function streamChat(messages, { customerId, conversationId, onEvent, signal }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, customerId, conversationId }),
    signal,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const evt of events) {
      if (!evt.startsWith('data:')) continue;
      const data = JSON.parse(evt.slice(5));
      if (data.error) throw new Error(data.error);
      onEvent(data);
    }
  }
}
