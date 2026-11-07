// GetYourGuide activities — searches tours via the GetYourGuide Partner API.
// Same API call, filters and sort score; results are cached in memory instead of a DE.
// Falls back to Holiday_Inventory activities (no photos) if the API key is missing or the call fails.
import { resolveDestination, getPackages } from '../data.js';

const cfg = () => ({
  key: process.env.GYG_API_KEY,
  baseUrl: (process.env.GYG_API_BASE_URL || 'https://api.getyourguide.com/1').replace(/\/+$/, ''),
  language: process.env.GYG_LANGUAGE || 'EN',
  currency: process.env.GYG_CURRENCY || 'EUR',
  imageFormat: process.env.GYG_IMAGE_FORMAT || '75',
  minRating: Number(process.env.GYG_MIN_RATING || 3),
  defaultWindowDays: 45,
});

// City names GYG understands better than our display names
const QUERY_OVERRIDES = { 'Faro / Algarve': 'Algarve', Tromso: 'Tromsø' };

const cache = new Map(); // url → { at, tours }
const CACHE_MS = 60 * 60 * 1000;

const isoDay = (d) => d.toISOString().slice(0, 10);

/** One GYG /tours call: data.tours[] → clean activity objects */
async function fetchTours({ query, dateFrom, dateTo, limit }) {
  const c = cfg();
  const params = new URLSearchParams();
  params.append('cnt_language', c.language);
  params.append('currency', c.currency);
  params.append('q', query);
  params.append('date[]', `${dateFrom}T00:00:00`);
  params.append('date[]', `${dateTo}T23:59:59`);
  params.append('limit', String(limit));
  params.append('rating[]', String(c.minRating));
  params.append('rating[]', '5');
  params.append('preformatted', 'teaser');
  const url = `${c.baseUrl}/tours?${params}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tours;

  let res;
  for (let attempt = 0; attempt < 3; attempt++) { // request.retries = 2
    res = await fetch(url, { headers: { 'X-ACCESS-TOKEN': c.key, Accept: 'application/json' } });
    if (res.ok || res.status < 500) break;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GetYourGuide ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const tours = (json?.data?.tours || [])
    .map((t) => {
      const rating = Math.round((Number(t.overall_rating) || 0) * 10) / 10;
      const ratingCount = parseInt(t.number_of_ratings || 0, 10);
      const pic = t.pictures?.[0]?.ssl_url || t.pictures?.[0]?.url;
      return {
        id: t.tour_id,
        title: t.title,
        description: t.abstract,
        image: pic ? pic.replace('[format_id]', c.imageFormat) : null,
        url: t.url,
        price: Number(t.price?.values?.amount) || 0,
        originalPrice: Number(t.price?.values?.special?.original_price) || null,
        bestseller: !!t.bestseller,
        likelyToSellOut: !!t.likely_to_sell_out,
        languages: t.cond_language || [],
        currency: c.currency,
        categories: [...new Set([t.partner_business_category, ...(t.categories || []).map((x) => x.name)].filter(Boolean))],
        activityType: t.activity_type,
        rating,
        ratingCount,
        duration: formatDuration(t.durations?.[0]),
        sortScore: Math.round(rating * 100000) + ratingCount,
      };
    })
    // keep only complete tours: id, title, photo, link, rating and price
    .filter((t) => t.id && t.title && t.image && t.url && t.rating !== 0 && t.price > 0)
    // drop tours only offered in other languages (e.g. "Anne Frank Walking Tour in German")
    .filter((t) => !t.languages.length || t.languages.includes(c.language.toLowerCase()))
    .sort((a, b) => b.sortScore - a.sortScore);

  cache.set(url, { at: Date.now(), tours });
  return tours;
}

function formatDuration(d) {
  if (!d?.duration) return null;
  const n = Number(d.duration);
  const unit = String(d.unit || '').toLowerCase();
  if (unit.startsWith('day')) return `${n} day${n === 1 ? '' : 's'}`;
  if (unit.startsWith('min')) {
    if (n >= 1440) return `${Math.round(n / 1440)} day${n >= 2880 ? 's' : ''}`;
    return n >= 60 ? `${Math.round((n / 60) * 10) / 10} h` : `${n} min`;
  }
  return `${n} h`;
}

/** Fallback: activities already listed in Holiday_Inventory for this destination */
async function inventoryActivities(dest, limit) {
  const names = new Map();
  for (const p of await getPackages()) {
    if (p.destinationId !== dest.id) continue;
    p.destinationActivities.forEach((a, i) => {
      if (!names.has(a)) names.set(a, p.destinationActivityCategories[i] || p.destinationActivityCategories[0] || null);
    });
  }
  return [...names].slice(0, limit).map(([title, category]) => ({ title, categories: category ? [category] : [] }));
}

export async function findActivities(args = {}) {
  const dest = await resolveDestination(args.destination);
  if (!dest) return { error: `Unknown destination "${args.destination}". Use a destination from the catalog.` };

  const limit = Math.min(Math.max(Number(args.limit) || 6, 6), 10); // always show at least 6
  const today = new Date();
  const dateFrom = args.date_from || isoDay(today);
  const dateTo = args.date_to || isoDay(new Date(new Date(`${dateFrom}T00:00:00Z`).getTime() + cfg().defaultWindowDays * 864e5));
  const keyword = String(args.interest || '').trim().toLowerCase();

  if (!cfg().key) {
    return {
      destination: dest.name,
      source: 'package-inventory',
      note: 'Live GetYourGuide data is not configured (GYG_API_KEY missing) — these are activities from our package inventory, without prices or photos.',
      results: await inventoryActivities(dest, limit),
    };
  }

  try {
    const query = QUERY_OVERRIDES[dest.name] || dest.name;
    // fetch more when filtering by interest, then trim
    // fetch extra: some tours get filtered out (no photo/price, other language)
    let tours = await fetchTours({ query, dateFrom, dateTo, limit: 30 });
    if (tours.length < limit) {
      const more = await fetchTours({ query: `iata:${dest.airport}`, dateFrom, dateTo, limit: 30 });
      const seen = new Set(tours.map((t) => t.id));
      tours = [...tours, ...more.filter((t) => !seen.has(t.id))];
    }

    let results = tours;
    let interestMatched = true;
    if (keyword) {
      const words = keyword.split(/[\s,]+/).filter((w) => w.length > 2);
      const filtered = tours.filter((t) =>
        words.some((w) => [t.title, t.description, t.activityType, ...t.categories].join(' ').toLowerCase().includes(w))
      );
      if (filtered.length) {
        // interest matches first, then fill up with the top-rated others
        const ids = new Set(filtered.map((t) => t.id));
        results = [...filtered, ...tours.filter((t) => !ids.has(t.id))];
      } else interestMatched = false;
    }
    results = results.slice(0, limit);

    return {
      destination: dest.name,
      source: 'getyourguide',
      dates: `${dateFrom} to ${dateTo}`,
      interest: keyword || undefined,
      note: keyword && !interestMatched ? `Nothing matched "${keyword}" exactly — showing the top-rated activities instead.` : undefined,
      results,
    };
  } catch (e) {
    console.error('[gyg]', e.message);
    return {
      destination: dest.name,
      source: 'package-inventory',
      note: 'GetYourGuide is unavailable right now — these are activities from our package inventory, without prices or photos.',
      results: await inventoryActivities(dest, limit),
    };
  }
}
