// Customer lookup + data catalog. Reads JSON produced by `npm run import` (scripts/import-excel.js).
// Falls back to customers.sample.json if the import hasn't been run yet.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

async function readJson(name, fallback) {
  const file = path.join(DATA_DIR, name);
  try {
    await access(file);
  } catch {
    if (!fallback) return [];
    return readJson(fallback);
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.error(`[data] could not read ${name}:`, e.message);
    return [];
  }
}

export const loadCustomers = () => readJson('customers.json', 'customers.sample.json');
export const loadDestinations = () => readJson('destinations.json');

const norm = (s) => String(s || '').trim().toLowerCase();
const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

/** Find by email or customer / member ID (accepts "C00001", "c 00001", "c00001"). */
export async function findCustomer(identifier) {
  const customers = await loadCustomers();
  if (isEmail(identifier)) return customers.find((c) => norm(c.email) === norm(identifier)) || null;
  const id = normId(identifier);
  return id ? customers.find((c) => normId(c.id) === id) || null : null;
}

export async function findById(id) {
  if (!id) return null;
  return (await loadCustomers()).find((c) => c.id === id) || null;
}

/** Minimal info safe to send to the browser. */
export function publicProfile(c) {
  return { id: c.id, firstName: c.firstName, tier: c.tier, homeAirport: c.homeAirport, language: c.language };
}

/** What the LLM sees about the customer (full profile — the customer can ask about their own data). */
export function llmProfile(c) {
  return c;
}
