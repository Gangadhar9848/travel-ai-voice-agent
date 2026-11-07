// Excel → JSON importer.
// Reads every .xlsx in server/data/raw and writes clean JSON files to server/data/.
// Run:  npm run import   (from the server folder)  — re-run whenever the Excel changes.
import ExcelJS from 'exceljs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const RAW_DIR = path.join(DATA_DIR, 'raw');

// Home city → nearest departure hub in the inventory (edit if you add airports)
const CITY_TO_HUB = {
  Stockholm: 'ARN', Uppsala: 'ARN',
  Copenhagen: 'CPH', Malmö: 'CPH', Aarhus: 'CPH', Odense: 'CPH', Gothenburg: 'CPH',
  Oslo: 'OSL', Bergen: 'OSL', Trondheim: 'OSL',
};

const SCORE_KEYS = ['beach', 'culture', 'food', 'nightlife', 'nature', 'adventure', 'family', 'romance', 'shopping', 'relaxation', 'value'];

// ---------- helpers ----------
function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);          // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;                          // hyperlink
  }
  return typeof v === 'string' ? v.trim() : v;
}

function sheetRows(ws) {
  const rows = [];
  let headers = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(cellValue);
    if (!headers) { headers = values.map((h) => String(h ?? '').trim()); return; }
    if (values.every((v) => v == null || v === '')) return;
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null])));
  });
  return rows;
}

const list = (s, sep = /[;|,]/) => (s == null || s === '' ? [] : String(s).split(sep).map((x) => x.trim()).filter(Boolean));
const num = (v) => (v == null || v === '' ? null : Number(v));

// ---------- load workbooks ----------
const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'));
if (!files.length) {
  console.error(`No .xlsx files found in ${RAW_DIR}`);
  process.exit(1);
}

const sheets = {};
for (const f of files) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(RAW_DIR, f));
  wb.eachSheet((ws) => { sheets[ws.name.toLowerCase()] = sheetRows(ws); });
  console.log(`Read ${f}: ${wb.worksheets.map((w) => w.name).join(', ')}`);
}

function need(name) {
  const rows = sheets[name.toLowerCase()];
  if (!rows) throw new Error(`Sheet "${name}" not found. Available: ${Object.keys(sheets).join(', ')}`);
  return rows;
}

// ---------- destinations ----------
const destinations = need('Destination_Master').map((d) => ({
  id: d.destination_id,
  name: d.destination_name,
  country: d.country,
  airport: d.airport_code,
  type: d.destination_type,
  scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, num(d[`${k}_score`])])),
  dailyCostEur: num(d.typical_daily_cost_eur),
  minDays: num(d.recommended_min_days),
  maxDays: num(d.recommended_max_days),
  bestSeason: d.best_season,
  headline: d.headline,
  summary: d.matching_summary,
  tags: list(d.semantic_tags),
}));
const destById = Object.fromEntries(destinations.map((d) => [d.id, d]));
const destByAirport = Object.fromEntries(destinations.map((d) => [d.airport, d]));
const airportName = (code) => destByAirport[code]?.name ?? code;

// ---------- packages ----------
const packages = need('Holiday_Inventory').map((p) => ({
  id: p.product_id,
  destinationId: p.destination_id,
  destination: p.destination_name,
  origin: p.origin_airport,
  hotelId: p.hotel_id,
  hotel: p.hotel_name,
  stars: num(p.star_rating),
  board: p.board_type,
  nights: num(p.nights),
  priceEur: num(p.package_price_eur),
  currency: p.currency,
  availability: p.availability_status,
  hotelActivities: list(p.hotel_activities, '|'),
  hotelActivityCategories: [...new Set(list(p.hotel_activity_categories, '|'))],
  destinationActivities: list(p.suggested_activities_at_destination, '|'),
  destinationActivityCategories: [...new Set(list(p.destination_activity_categories, '|'))],
}));

// ---------- flights ----------
const flights = need('Flight_Inventory').map((f) => ({
  flight: f.flight_number,
  origin: f.origin_airport,
  destinationAirport: f.destination_airport,
  destinationId: f.destination_id,
  destination: f.destination_name,
  country: f.country,
  route: f.route_key,
  carrier: f.carrier,
  date: f.departure_date,
}));

// ---------- quiz ----------
const quizMap = new Map();
for (const q of need('Quiz_Attribute_Mapping')) {
  if (!quizMap.has(q.question_id)) quizMap.set(q.question_id, { id: q.question_id, question: q.question, answers: [] });
  quizMap.get(q.question_id).answers.push({
    id: q.answer_id,
    text: q.answer_text,
    weights: Object.fromEntries(SCORE_KEYS.map((k) => [k, num(q[`${k}_weight`]) ?? 0])),
  });
}
const quiz = [...quizMap.values()];

// ---------- customers + bookings ----------
const bookingsByCustomer = {};
for (const b of need('booking_data')) {
  (bookingsByCustomer[b.customer_id] ??= []).push({
    pnr: b.PNR,
    bookedOn: b.PNR_date,
    status: b.status,
    flight: b.flight_number,
    from: b.origin_airport,
    toAirport: b.destination_airport,
    destination: destById[b.destination_id]?.name ?? b.destination_airport,
    country: destById[b.destination_id]?.country ?? null,
    departureDate: b.departure_date,
    passengers: num(b.passenger_count),
  });
}

const customers = need('Customer_Data').map((c) => {
  const bookings = (bookingsByCustomer[c.customer_id] ?? []).sort((a, b) => String(b.departureDate).localeCompare(String(a.departureDate)));
  return {
    id: c.customer_id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    ageBand: c.age_band,
    homeCity: c.home_city,
    homeAirport: CITY_TO_HUB[c.home_city] ?? null,
    language: c.language,
    tier: c.loyalty_tier,
    preferredTravelType: c.preferred_travel_type,
    travelParty: c.travel_party,
    avgTripBudgetEur: num(c.avg_trip_budget_EUR),
    preferredSeason: c.preferred_season,
    favoriteDestinations: list(c.favorite_destinations).map(airportName),
    recentSearches: list(c.recent_search_destinations).map(airportName),
    ancillariesLast3Bookings: list(c.ancillary_last_3_bookings),
    bookings,
  };
});

// ---------- write ----------
const out = { customers, destinations, packages, flights, quiz };
for (const [name, data] of Object.entries(out)) {
  await writeFile(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
}

const noHub = customers.filter((c) => !c.homeAirport).map((c) => c.homeCity);
console.log(`\nWrote to ${DATA_DIR}:`);
console.log(`  customers.json    ${customers.length} customers, ${Object.values(bookingsByCustomer).flat().length} bookings`);
console.log(`  destinations.json ${destinations.length}`);
console.log(`  packages.json     ${packages.length}`);
console.log(`  flights.json      ${flights.length}`);
console.log(`  quiz.json         ${quiz.length} questions`);
if (noHub.length) console.warn(`  ⚠ No hub mapping for home cities: ${[...new Set(noHub)].join(', ')} — add them to CITY_TO_HUB`);
