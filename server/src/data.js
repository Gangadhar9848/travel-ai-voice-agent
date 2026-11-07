// Cached JSON loader for server/data/*.json — reloads automatically when a file changes
// (e.g. after `npm run import`), so no server restart is needed.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const cache = new Map();

export async function loadJson(name) {
  const file = path.join(DATA_DIR, name);
  let mtime;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return null; // file missing
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  const data = JSON.parse(await readFile(file, 'utf8'));
  cache.set(file, { mtime, data });
  return data;
}

export const getDestinations = async () => (await loadJson('destinations.json')) ?? [];
export const getPackages = async () => (await loadJson('packages.json')) ?? [];
export const getFlights = async () => (await loadJson('flights.json')) ?? [];
export const getQuiz = async () => (await loadJson('quiz.json')) ?? [];

/** Resolve a destination by id ("D003"), airport ("BCN") or (partial) name ("barcelona", "algarve"). */
export async function resolveDestination(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  const all = await getDestinations();
  return (
    all.find((d) => d.id.toLowerCase() === q || d.airport.toLowerCase() === q || d.name.toLowerCase() === q) ||
    all.find((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase().split(' ')[0])) ||
    null
  );
}
