// Holiday_Inventory (packages) and Flight_Inventory (flights) search.
import { getPackages, getFlights, resolveDestination } from '../data.js';

const BOARD_RANK = { 'room only': 0, breakfast: 1, 'half board': 2, 'full board': 3, 'all inclusive': 4 };

export async function searchPackages(args = {}, { customer } = {}) {
  const dest = await resolveDestination(args.destination);
  if (args.destination && !dest) return { error: `Unknown destination "${args.destination}". Use a destination from the catalog.` };

  const origin = (args.origin || customer?.homeAirport || '').toUpperCase() || null;
  const minBoard = args.board ? BOARD_RANK[String(args.board).toLowerCase()] : null;

  let list = (await getPackages()).filter((p) =>
    (!dest || p.destinationId === dest.id) &&
    (!origin || p.origin === origin) &&
    (!args.nights || p.nights === Number(args.nights)) &&
    (!args.min_nights || p.nights >= Number(args.min_nights)) &&
    (!args.max_nights || p.nights <= Number(args.max_nights)) &&
    (!args.max_price_eur || p.priceEur <= Number(args.max_price_eur)) &&
    (!args.min_stars || p.stars >= Number(args.min_stars)) &&
    (minBoard == null || (BOARD_RANK[p.board.toLowerCase()] ?? 0) >= minBoard) &&
    (!args.activity || [...p.hotelActivities, ...p.hotelActivityCategories, ...p.destinationActivities, ...p.destinationActivityCategories]
      .some((a) => a.toLowerCase().includes(String(args.activity).toLowerCase())))
  );

  const total = list.length;
  const sort = args.sort || 'price';
  list.sort((a, b) =>
    sort === 'stars' ? b.stars - a.stars || a.priceEur - b.priceEur
    : sort === 'price_per_night' ? a.priceEur / a.nights - b.priceEur / b.nights
    : a.priceEur - b.priceEur
  );
  // Prefer Available over Limited when prices are close? Keep simple: return as sorted.
  const results = list.slice(0, Math.min(Number(args.limit) || 4, 8)).map((p) => ({
    id: p.id,
    destination: p.destination,
    origin: p.origin,
    hotel: p.hotel,
    stars: p.stars,
    board: p.board,
    nights: p.nights,
    priceEur: p.priceEur,
    availability: p.availability,
    hotelActivities: p.hotelActivities,
    thingsToDo: p.destinationActivities,
  }));

  return {
    filters: { destination: dest?.name ?? null, origin, nights: args.nights ?? null, max_price_eur: args.max_price_eur ?? null },
    totalMatching: total,
    results,
    note: total ? undefined : 'No packages match. Suggest relaxing filters (other nights, board, budget) or another origin.',
  };
}

export async function getPackage(id) {
  return (await getPackages()).find((p) => p.id === String(id).toUpperCase()) || null;
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function findFlights(args = {}, { customer } = {}) {
  const dest = await resolveDestination(args.destination);
  if (!dest) return { error: `Unknown destination "${args.destination}".` };
  const origin = (args.origin || customer?.homeAirport || '').toUpperCase() || null;

  const all = (await getFlights()).filter((f) => f.destinationId === dest.id && (!origin || f.origin === origin));
  const inRange = all
    .filter((f) => (!args.date_from || f.date >= args.date_from) && (!args.date_to || f.date <= args.date_to))
    .sort((a, b) => a.date.localeCompare(b.date));

  const nights = Number(args.nights) || null;
  const results = inRange.slice(0, Math.min(Number(args.limit) || 6, 12)).map((f) => ({
    flight: f.flight,
    route: f.route,
    departureDate: f.date,
    returnDate: nights ? addDays(f.date, nights) : undefined,
  }));

  const dates = all.map((f) => f.date).sort();
  return {
    destination: dest.name,
    origin,
    totalFlightsOnRoute: all.length,
    scheduleCoverage: dates.length ? `${dates[0]} to ${dates.at(-1)}` : 'no flights on this route',
    results,
    note: 'Outbound flights only; return flight is arranged with the package and confirmed by a consultant.',
  };
}
