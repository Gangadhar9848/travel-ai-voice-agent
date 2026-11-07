// Thin client for OpenAI / Azure OpenAI Chat Completions (no SDK, plain fetch).
// Supports streaming text + tool (function) calls.

function config() {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  // Newer models (reasoning / GPT-5+) need max_completion_tokens and may reject temperature.
  // Leave LLM_TEMPERATURE empty in .env to omit it.
  const common = { max_completion_tokens: Number(process.env.LLM_MAX_TOKENS || 2000) };
  if (process.env.LLM_TEMPERATURE) common.temperature = Number(process.env.LLM_TEMPERATURE);
  // Some models (e.g. gpt-6-luna on /chat/completions) only allow tools with reasoning_effort 'none'
  if (process.env.LLM_REASONING_EFFORT) common.reasoning_effort = process.env.LLM_REASONING_EFFORT;

  if (provider === 'azure') {
    const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    if (!endpoint || !deployment || !process.env.AZURE_OPENAI_API_KEY) {
      throw new Error('Azure config missing: set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY in server/.env');
    }
    return {
      provider,
      label: `azure:${deployment}`,
      url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
      headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
      body: { ...common },
    };
  }

  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI config missing: set OPENAI_API_KEY in server/.env');
  }
  return {
    provider: 'openai',
    label: `openai:${model}`,
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: { ...common, model },
  };
}

export function llmLabel() {
  try { return config().label; } catch { return 'not configured'; }
}

/**
 * Streams one chat completion.
 * - onToken(text) is called for each text chunk
 * - returns { content, toolCalls: [{ id, name, arguments }] }
 */
export async function streamChat(messages, { tools, onToken = () => {}, signal } = {}) {
  const cfg = config();
  const body = { ...cfg.body, messages, stream: true, stream_options: { include_usage: true } }; // usage = token counts at end of stream
  if (tools?.length) body.tools = tools;
  let res;

  // Retry (max 3x) dropping any parameter the model says it doesn't support
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) break;

    const text = await res.text().catch(() => '');
    let param;
    try { param = JSON.parse(text).error?.param; } catch {}
    const unsupported = res.status === 400 && /unsupported/i.test(text);
    // "Function tools with reasoning_effort are not supported … set reasoning_effort to 'none'"
    if (res.status === 400 && /reasoning_effort/i.test(text) && body.tools && body.reasoning_effort !== 'none') {
      console.warn("[llm] model needs reasoning_effort 'none' when using tools — retrying (set LLM_REASONING_EFFORT=none in .env to skip this)");
      body.reasoning_effort = 'none';
      continue;
    }
    if (unsupported && param === 'max_completion_tokens') {
      body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens;
      continue;
    }
    if (unsupported && param && param in body && !['messages', 'tools'].includes(param)) {
      console.warn(`[llm] model rejected '${param}', retrying without it`);
      delete body[param];
      continue;
    }
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.ok) throw new Error(`LLM ${res.status}: request rejected after retries`);

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = [];

  let usage = null;
  const handle = (data) => {
    const json = JSON.parse(data);
    if (json.usage) usage = json.usage;          // last chunk carries token counts
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) { content += delta.content; onToken(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      calls[i] ??= { id: '', name: '', arguments: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name = tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
  };

  outer: for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      try { handle(data); } catch { /* ignore keep-alive / partial lines */ }
    }
  }

  return { content, toolCalls: calls.filter(Boolean).filter((c) => c.name), usage };
}
