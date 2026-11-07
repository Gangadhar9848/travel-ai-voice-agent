// Guardrails — safety checks in CODE, so a rule can't be skipped even if the LLM slips.
// The md rules ask the model to behave; these functions enforce it.
//
//   guardInput()  → before the brain: card numbers, message length, rate limit
//   guardOutput() → after the brain:  invented prices, other customers' data, card numbers
//   (the loop guard — repeated / too many tool calls — lives in agent.js)

// ---------- limits (change here) ----------
export const LIMITS = {
  maxMessageChars: 1000,      // longer customer messages are cut
  ratePerMinute: 20,          // messages per minute per customer / browser
  maxToolCalls: 6,            // tool calls per customer message (used in agent.js)
};

const CARD_NOTICE = '🔒 For your safety I removed the card number from your message. Please never share card details in this chat.';
const RATE_MESSAGE = "You're sending messages very quickly. Please wait a moment and try again.";

// ---------- helpers ----------
/** Luhn check: real card numbers pass it, random long numbers usually don't */
function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/** Replace card numbers (13–19 digits, spaces/dashes allowed, Luhn-valid) with a placeholder */
export function redactCards(text) {
  let found = 0;
  const out = String(text).replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { found++; return '[card number removed]'; }
    return m;
  });
  return { text: out, found };
}

const rate = new Map(); // key → timestamps of recent messages
function rateLimited(key) {
  if (!key) return false;
  const now = Date.now();
  const recent = (rate.get(key) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  rate.set(key, recent);
  return recent.length > LIMITS.ratePerMinute;
}

/** Every € amount in the text: [{ raw, value }] — "€470", "470 euros", "1 250 EUR" */
function euroAmounts(text) {
  const found = [];
  const add = (raw, num) => found.push({ raw, value: Number(num.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) });
  for (const m of text.matchAll(/€\s?(\d[\d\s.,]*\d|\d)/g)) add(m[0], m[1]);
  for (const m of text.matchAll(/(\d[\d\s.,]*\d|\d)\s?(?:€|EUR\b|euros?\b)/gi)) add(m[0], m[1]);
  return found;
}

/** € amounts in `text` that don't appear anywhere in `sources` (tool results + conversation) */
export function findInventedPrices(text, sources) {
  const allowed = new Set([...String(sources).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.'))));
  return euroAmounts(String(text)).filter((p) => !allowed.has(p.value));
}

// ---------- INPUT GUARD ----------
/**
 * @returns {{ history, blocked?: string, notice?: string, lastUser: string, issues: {name, detail}[] }}
 */
export function guardInput(history, { rateKey } = {}) {
  const issues = [];
  if (rateLimited(rateKey)) {
    issues.push({ name: 'rate_limit', detail: `more than ${LIMITS.ratePerMinute} messages in a minute` });
    return { history, blocked: RATE_MESSAGE, lastUser: history.at(-1)?.content || '', issues };
  }

  let cards = 0;
  const clean = history.map((m, i) => {
    if (m.role !== 'user') return m;
    let content = m.content;
    const r = redactCards(content);
    if (r.found && i === history.length - 1) cards += r.found;
    content = r.text;
    if (i === history.length - 1 && content.length > LIMITS.maxMessageChars) {
      issues.push({ name: 'message_too_long', detail: `${content.length} chars, cut to ${LIMITS.maxMessageChars}` });
      content = content.slice(0, LIMITS.maxMessageChars);
    }
    return { ...m, content };
  });
  if (cards) issues.push({ name: 'card_number', detail: `${cards} card number(s) removed from the customer's message` });

  return { history: clean, notice: cards ? CARD_NOTICE : undefined, lastUser: clean.at(-1)?.content || '', issues };
}

// ---------- OUTPUT GUARD ----------
/**
 * @param text     the agent's final answer
 * @param sources  everything the answer may legitimately quote: tool results + conversation text
 * @param mode     'text' | 'voice' (wording of replacements)
 * @returns {{ text, changed: boolean, issues: {name, detail}[] }}
 */
export function guardOutput(text, { customer, sources = '', mode = 'text' } = {}) {
  let out = String(text || '');
  const issues = [];

  // 1. invented prices
  const invented = findInventedPrices(out, sources);
  if (invented.length) {
    const placeholder = mode === 'voice' ? 'the price shown on your screen' : '[see card for price]';
    for (const p of invented) out = out.split(p.raw).join(placeholder);
    if (mode === 'text') out += '\n\n_Please check the cards for exact, up-to-date prices._';
    issues.push({ name: 'invented_price', detail: `removed €${invented.map((p) => p.value).join(', €')} (not from any tool result)` });
  }

  // 2. other customers' data (IDs like C00017, emails that aren't this customer's)
  const myId = customer?.id?.toUpperCase();
  const myEmail = customer?.email?.toLowerCase();
  const leaked = [];
  out = out.replace(/\bC\d{5}\b/g, (m) => (m.toUpperCase() === myId ? m : (leaked.push(m), '[removed]')));
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => (m.toLowerCase() === myEmail ? m : (leaked.push(m), '[removed]')));
  if (leaked.length) issues.push({ name: 'other_customer_data', detail: `removed ${leaked.join(', ')}` });

  // 3. card numbers in the answer
  const cards = redactCards(out);
  if (cards.found) { out = cards.text; issues.push({ name: 'card_number_in_answer', detail: `${cards.found} removed` }); }

  return { text: out, changed: issues.length > 0, issues };
}
