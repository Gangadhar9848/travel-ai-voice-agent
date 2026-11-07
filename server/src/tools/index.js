// Tool registry: definitions sent to the LLM + dispatcher.
// Each tool returns { result } for the LLM, and optionally { ui } which is streamed to the browser as cards.
import { matchDestinations, ATTRS } from './matchmaker.js';
import { searchPackages, findFlights } from './inventory.js';
import { findActivities } from './activities.js';
import { getQuiz } from '../data.js';

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'show_mood_quiz',
      description:
        'Show the 3-question mood quiz as clickable cards. Use when the customer is unsure where to go, says "surprise me", or wants help choosing. The answers come back as the next user message.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'match_destinations',
      description:
        'Rank our destinations for this customer by scoring their mood against each destination (beach, culture, food, nightlife, nature, adventure, family, romance, shopping, relaxation, value). Pass quiz_answers if they did the quiz, and/or mood_weights you infer from what they wrote. Member profile is blended in automatically.',
      parameters: {
        type: 'object',
        properties: {
          quiz_answers: {
            type: 'array',
            description: 'Answers from the mood quiz, e.g. [{"question_id":"Q01","answer_id":"A"}]',
            items: {
              type: 'object',
              properties: { question_id: { type: 'string' }, answer_id: { type: 'string' } },
              required: ['question_id', 'answer_id'],
            },
          },
          mood_weights: {
            type: 'object',
            description: 'How much the customer wants each attribute, 0-10 (only include relevant ones). E.g. "I need peace by the sea" → {"relaxation":9,"beach":8}',
            properties: Object.fromEntries(ATTRS.map((k) => [k, { type: 'number', minimum: 0, maximum: 10 }])),
          },
          travel_party: { type: 'string', enum: ['solo', 'couple', 'family', 'friends'] },
          travel_month: { type: 'integer', minimum: 1, maximum: 12, description: 'Month they want to travel (1-12)' },
          max_daily_cost_eur: { type: 'number', description: 'Budget per day in EUR, if known' },
          origin: { type: 'string', enum: ['CPH', 'ARN', 'OSL'], description: 'Departure hub (defaults to member home airport)' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Destination names to leave out' },
          top_n: { type: 'integer', minimum: 1, maximum: 6, description: 'How many to return (default 3)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_packages',
      description: 'Search real flight+hotel packages in our inventory. Returns hotel, stars, board, nights, price (EUR), availability and activities.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Destination name, airport code or id from the catalog' },
          origin: { type: 'string', enum: ['CPH', 'ARN', 'OSL'] },
          nights: { type: 'integer', description: 'Exact number of nights (inventory has 2, 3, 4, 5, 7, 10)' },
          min_nights: { type: 'integer' },
          max_nights: { type: 'integer' },
          max_price_eur: { type: 'number' },
          min_stars: { type: 'integer', minimum: 1, maximum: 5 },
          board: { type: 'string', enum: ['Room only', 'Breakfast', 'Half board'], description: 'Minimum board level' },
          activity: { type: 'string', description: 'Keyword for hotel or destination activities, e.g. "yoga", "boat", "kids"' },
          sort: { type: 'string', enum: ['price', 'stars', 'price_per_night'] },
          limit: { type: 'integer', minimum: 1, maximum: 8 },
        },
        required: ['destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_flights',
      description: 'Find outbound flight dates from a departure hub (CPH, ARN or OSL) to a destination. Pass nights to also get the return date.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          origin: { type: 'string', enum: ['CPH', 'ARN', 'OSL'] },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
          nights: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 12 },
        },
        required: ['destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_activities',
      description:
        'Find things to do at a destination (tours, attractions, experiences) from GetYourGuide, with photos, rating, price and booking link. Shown to the customer as cards.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Destination name, airport code or id from the catalog' },
          interest: { type: 'string', description: 'Optional keyword(s) matching the mood/party, e.g. "food", "boat", "kids", "hiking", "museum"' },
          date_from: { type: 'string', description: 'YYYY-MM-DD — trip start if known' },
          date_to: { type: 'string', description: 'YYYY-MM-DD — trip end if known' },
          limit: { type: 'integer', minimum: 6, maximum: 10, description: 'Default 6 — always show at least 6' },
        },
        required: ['destination'],
      },
    },
  },
];

const STATUS = {
  show_mood_quiz: 'Preparing your mood quiz…',
  match_destinations: 'Finding your best destination matches…',
  search_packages: 'Searching holiday packages…',
  find_flights: 'Checking flights…',
  find_activities: 'Finding things to do…',
};
export const toolStatus = (name) => STATUS[name] || 'Working on it…';

export async function runTool(name, args, ctx) {
  switch (name) {
    case 'show_mood_quiz': {
      const quiz = await getQuiz();
      return {
        result: { shown: true, note: 'Quiz is displayed to the customer. Wait for their answers in the next message; do not list the questions yourself.' },
        ui: { type: 'quiz', data: quiz, note: 'Mood quiz shown to the customer.' },
      };
    }
    case 'match_destinations': {
      const result = await matchDestinations(args, ctx);
      if (result.error) return { result };
      return {
        result,
        ui: {
          type: 'matches',
          data: result,
          note: `Destination match cards shown: ${result.results.map((r) => `${r.name} ${r.matchPercent}%`).join(', ')}.`,
        },
      };
    }
    case 'search_packages': {
      const result = await searchPackages(args, ctx);
      if (result.error || !result.results.length) return { result };
      return {
        result,
        ui: {
          type: 'packages',
          data: result,
          note: `Package cards shown: ${result.results.map((p) => `${p.id} ${p.hotel} ${p.nights}n €${p.priceEur}`).join('; ')}.`,
        },
      };
    }
    case 'find_activities': {
      const result = await findActivities(args);
      if (result.error || !result.results.length) return { result };
      return {
        result,
        ui: {
          type: 'activities',
          data: result,
          note: `Activity cards shown for ${result.destination} (${result.source}): ${result.results.map((a) => a.title).join('; ')}.`,
        },
      };
    }
    case 'find_flights':
      return { result: await findFlights(args, ctx) };
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}
