// Loads every .md file in server/prompts (alphabetical order) into ONE system prompt.
// Files are re-read on every request, so edits apply instantly — no restart needed.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDestinations, llmProfile } from './customers.js';
import { loadMemory, memoryForPrompt } from './memory.js';

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');

export async function listPromptFiles() {
  const files = await readdir(PROMPTS_DIR);
  return files.filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
}

export async function buildSystemPrompt(context = {}) {
  const files = await listPromptFiles();
  const parts = await Promise.all(
    files.map(async (f) => (await readFile(path.join(PROMPTS_DIR, f), 'utf8')).trim())
  );

  let prompt = parts.join('\n\n---\n\n');

  // Destination catalog (from Excel → destinations.json)
  const destinations = await loadDestinations();
  if (destinations.length) {
    prompt += `\n\n---\n\n# Destination catalog (the ONLY destinations we sell)\n`;
    prompt += `Scores are 0-10. Format: name (airport) | type | best season | typical €/day | recommended days | top strengths | tags\n`;
    for (const d of destinations) {
      const top = Object.entries(d.scores).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');
      prompt += `- ${d.name}, ${d.country} (${d.airport}) | ${d.type} | ${d.bestSeason} | €${d.dailyCostEur}/day | ${d.minDays}-${d.maxDays} days | ${top} | ${d.tags.join(', ')}\n`;
    }
  }

  // Runtime context
  const today = new Date().toISOString().slice(0, 10);
  prompt += `\n\n---\n\n# Runtime context\n- Today's date: ${today}`;
  if (context.customer) {
    prompt += `\n- User type: **Member (verified)**`;
    prompt += `\n- Customer profile:\n\`\`\`json\n${JSON.stringify(llmProfile(context.customer))}\n\`\`\``;
    // MEMORY: earlier conversations with this member (context.memory = test override)
    const mem = context.memory !== undefined ? context.memory : await loadMemory(context.customer.id);
    const memText = memoryForPrompt(mem, context.conversationId);
    prompt += memText
      ? `\n- Previous conversations with this customer (from memory, most recent first):\n${memText}`
      : `\n- Previous conversations: none remembered yet`;
  } else {
    prompt += `\n- User type: **Guest** (not logged in, no profile)`;
  }
  return prompt;
}
