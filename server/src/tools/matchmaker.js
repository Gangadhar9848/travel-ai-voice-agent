// Holiday Matchmaker: mood (quiz answers and/or free-text weights) × Destination_Master scores → ranking.
import { getDestinations, getQuiz, getPackages } from '../data.js';

export const ATTRS = ['beach', 'culture', 'food', 'nightlife', 'nature', 'adventure', 'family', 'romance', 'shopping', 'relaxation', 'value'];

// Small nudges from who is travelling / what the member usually likes (edit freely)
const PARTY_BOOST = {
  family: { family: 8 },
  couple: { romance: 6 },
  friends: { nightlife: 4, food: 2 },
  solo: { culture: 2, adventure: 2 },
};
const TYPE_BOOST = {
  adventure: { adventure: 3 }, nightlife: { nightlife: 3 }, family: { family: 3 }, relaxation: { relaxation: 3 },
  nature: { nature: 3 }, culture: { culture: 3 }, food: { food: 3 }, 'city break': { culture: 2, shopping: 2 },
  romantic: { romance: 3 }, beach: { beach: 3 },
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function add(target, weights, factor = 1) {
  for (const [k, v] of Object.entries(weights || {})) {
    if (ATTRS.includes(k) && Number.isFinite(Number(v))) target[k] += Number(v) * factor;
  }
}

/** "Apr-Oct" / "Nov-Mar" / "Year-round" → is month (1-12) in season? */
export function inSeason(bestSeason, month) {
  if (!month || !bestSeason || /year/i.test(bestSeason)) return true;
  const [a, b] = bestSeason.toLowerCase().split(/\s*[-–]\s*/).map((m) => MONTHS.indexOf(m.slice(0, 3)) + 1);
  if (!a || !b) return true;
  return a <= b ? month >= a && month <= b : month >= a || month <= b; // wraps over new year
}

export async function matchDestinations(args = {}, { customer } = {}) {
  const quiz = await getQuiz();
  const weights = Object.fromEntries(ATTRS.map((k) => [k, 0]));
  const used = [];

  // 1) Quiz answers
  for (const ans of args.quiz_answers || []) {
    const q = quiz.find((x) => x.id === ans.question_id);
    const a = q?.answers.find((x) => x.id === String(ans.answer_id).toUpperCase());
    if (a) { add(weights, a.weights); used.push(`quiz ${q.id}: ${a.text}`); }
  }
  // 2) Free-text mood mapped by the LLM (0-10 per attribute)
  if (args.mood_weights && Object.keys(args.mood_weights).length) {
    add(weights, args.mood_weights);
    used.push('mood from conversation');
  }
  const hasMood = ATTRS.some((k) => weights[k] > 0);

  // 3) Profile / party nudges
  const party = (args.travel_party || customer?.travelParty || '').toLowerCase();
  if (PARTY_BOOST[party]) { add(weights, PARTY_BOOST[party]); used.push(`travel party: ${party}`); }
  const type = (customer?.preferredTravelType || '').toLowerCase();
  if (customer && TYPE_BOOST[type]) { add(weights, TYPE_BOOST[type], hasMood ? 1 : 3); used.push(`profile preference: ${type}`); }

  const total = ATTRS.reduce((s, k) => s + weights[k], 0);
  if (!total) {
    return { error: 'Not enough information to match. Ask the mood quiz (show_mood_quiz) or pass mood_weights.' };
  }

  const month = Number(args.travel_month) || null;
  const maxDaily = Number(args.max_daily_cost_eur) || null;
  const origin = (args.origin || customer?.homeAirport || '').toUpperCase() || null;
  const exclude = (args.exclude || []).map((s) => String(s).toLowerCase());
  const packages = origin ? await getPackages() : [];

  const upcoming = new Map();
  const visited = new Set();
  for (const b of customer?.bookings || []) {
    if (b.status === 'UPCOMING') upcoming.set(b.destination, b.departureDate);
    if (b.status === 'FLOWN') visited.add(b.destination);
  }

  const results = (await getDestinations())
    .filter((d) => !exclude.some((e) => d.name.toLowerCase().includes(e) || d.id.toLowerCase() === e))
    .map((d) => {
      const contrib = ATTRS.map((k) => [k, weights[k] * (d.scores[k] ?? 0)]);
      let score = (contrib.reduce((s, [, v]) => s + v, 0) / (total * 10)) * 100;
      const notes = [];
      const seasonOk = inSeason(d.bestSeason, month);
      if (!seasonOk) { score -= 15; notes.push(`outside best season (${d.bestSeason})`); }
      if (maxDaily && d.dailyCostEur > maxDaily) { score -= 10; notes.push(`above budget (€${d.dailyCostEur}/day)`); }
      if (upcoming.has(d.name)) { score -= 20; notes.push(`customer already has an upcoming trip here (${upcoming.get(d.name)})`); }
      else if (visited.has(d.name)) notes.push('customer has been here before');

      const fromPkgs = packages.filter((p) => p.destinationId === d.id && p.origin === origin);
      return {
        id: d.id,
        name: d.name,
        country: d.country,
        airport: d.airport,
        type: d.type,
        matchPercent: Math.max(0, Math.round(score)),
        whyItMatches: contrib.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => `${k} ${d.scores[k]}/10`),
        bestSeason: d.bestSeason,
        inSeason: seasonOk,
        dailyCostEur: d.dailyCostEur,
        recommendedDays: `${d.minDays}-${d.maxDays}`,
        fromPriceEur: fromPkgs.length ? Math.min(...fromPkgs.map((p) => p.priceEur)) : null,
        packagesFromOrigin: origin ? fromPkgs.length : undefined,
        notes,
      };
    })
    .sort((a, b) => b.matchPercent - a.matchPercent)
    .slice(0, Math.min(Number(args.top_n) || 3, 6));

  const topWeights = ATTRS.filter((k) => weights[k] > 0).sort((a, b) => weights[b] - weights[a]).slice(0, 4);
  return {
    basedOn: used,
    moodProfile: topWeights.map((k) => `${k} ${Math.round(weights[k])}`),
    origin,
    travelMonth: month,
    results,
  };
}
