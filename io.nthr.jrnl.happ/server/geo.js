import { db, now } from './db.js';

/**
 * Geocoding and place search, which on iOS come from CLGeocoder
 * and MKLocalSearch. The web has no equivalent built in, so this proxies
 * OpenStreetMap's public services — Nominatim for reverse/forward geocoding,
 * Overpass for the nearby-places list.
 *
 * Requests go through the server rather than the browser so we can identify
 * ourselves properly, serialize calls to respect Nominatim's 1 req/sec policy,
 * and cache results — repeated writing from the same place should cost nothing.
 * Every call degrades quietly (null / empty list) when upstream is unreachable,
 * matching the "quiet failure" principle: the app never blocks writing.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = process.env.JRNL_GEO_UA ?? 'Jrnl/1.0 (self-hosted journal app)';

const DAY = 24 * 60 * 60 * 1000;
const readCache = db.prepare('SELECT value, created_at FROM geo_cache WHERE key = ?');
const writeCache = db.prepare(
  'INSERT OR REPLACE INTO geo_cache (key, value, created_at) VALUES (?, ?, ?)'
);

function cached(key, ttl) {
  const row = readCache.get(key);
  if (!row || now() - row.created_at > ttl) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

const store = (key, value) => writeCache.run(key, JSON.stringify(value), now());

/**
 * Nominatim's usage policy allows at most one request per second from a given
 * source, so upstream calls queue behind a single chain rather than firing in
 * parallel. The chain's depth is bounded by `reserve` in rate.js, which the
 * request handler claims before it gets here.
 */
let chain = Promise.resolve();
let lastCallAt = 0;

function serialize(task) {
  const result = chain.then(async () => {
    const wait = Math.max(0, 1100 - (now() - lastCallAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      lastCallAt = now();
    }
  });
  // Keep the chain alive even when a task rejects.
  chain = result.catch(() => {});
  return result;
}

async function fetchJSON(url, { timeout = 12_000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null; // Offline or upstream trouble: the caller degrades quietly.
  } finally {
    clearTimeout(timer);
  }
}

const round = (value, places = 4) => Number(Number(value).toFixed(places));

export function haversine(a, b) {
  const R = 6_371_000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// MARK: - Reverse geocoding

/** "Oakland, CA" — region abbreviated the way the iOS geocoder returns it. */
function cityString(address) {
  const locality =
    address.city ?? address.town ?? address.village ?? address.municipality ?? address.hamlet;
  if (!locality) return null;
  const iso = address['ISO3166-2-lvl4'];
  const region = iso ? iso.split('-').pop() : address.state;
  return region ? `${locality}, ${region}` : locality;
}

/** "Temescal, Oakland" — falls back to the city where there is no neighbourhood. */
function neighborhoodString(address, city) {
  const locality =
    address.city ?? address.town ?? address.village ?? address.municipality ?? address.hamlet;
  const area =
    address.neighbourhood ?? address.suburb ?? address.quarter ?? address.city_district;
  if (area && locality) return `${area}, ${locality}`;
  return city;
}

/** The two place names a coordinate resolves to, per granularity level. */
export async function resolveNames(lat, lon) {
  const key = `rev:${round(lat)},${round(lon)}`;
  const hit = cached(key, 30 * DAY);
  if (hit !== undefined) return hit;

  const url = `${NOMINATIM}/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=18&addressdetails=1`;
  const data = await serialize(() => fetchJSON(url));
  const address = data?.address;
  if (!address) return { city: null, neighborhood: null };

  const city = cityString(address);
  const names = { city, neighborhood: neighborhoodString(address, city) };
  store(key, names);
  return names;
}

/**
 * The representative point for a place name — the web's stand-in for
 * forward-geocoding a locality to its centroid. City and neighborhood entries
 * store this instead of the precise device position, so a coarse tag never
 * retains where the user actually was.
 */
export async function centroid(placeName) {
  const key = `centroid:${placeName.toLowerCase()}`;
  const hit = cached(key, 90 * DAY);
  if (hit !== undefined) return hit;

  const url = `${NOMINATIM}/search?q=${encodeURIComponent(placeName)}&format=jsonv2&limit=1`;
  const data = await serialize(() => fetchJSON(url));
  const first = Array.isArray(data) ? data[0] : null;
  if (!first) return null;

  const point = { latitude: Number(first.lat), longitude: Number(first.lon) };
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  store(key, point);
  return point;
}

// MARK: - Places

const POI_KINDS = '^(amenity|shop|tourism|leisure|office|craft|healthcare)$';

/** Nearby named places, closest first — the picker's default list. */
export async function nearbyPOIs(lat, lon, radius = 400) {
  const center = { lat: round(lat, 3), lon: round(lon, 3) };
  const key = `poi:${center.lat},${center.lon},${radius}`;
  const hit = cached(key, 7 * DAY);
  if (hit !== undefined) return hit;

  const query = `[out:json][timeout:15];nwr(around:${radius},${lat},${lon})["name"][~"${POI_KINDS}"~"."];out center 80;`;
  const data = await serialize(() =>
    fetchJSON(OVERPASS, {
      method: 'POST',
      // Overpass queues requests behind other users and can take a while.
      timeout: 30_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    })
  );
  if (!data?.elements) return [];

  // Overpass knows the place but not what to call the surrounding town, so the
  // locality half of "Bob's Burgers, Brooklyn" comes from one reverse lookup.
  const names = await resolveNames(lat, lon);
  const locality = names.city?.split(',')[0] ?? null;

  const results = data.elements
    .map((element) => {
      const point = element.center ?? element;
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
      return {
        name: element.tags?.name,
        locality,
        latitude: point.lat,
        longitude: point.lon,
        distance: haversine({ lat, lon }, { lat: point.lat, lon: point.lon }),
      };
    })
    .filter((poi) => poi?.name)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 50);

  store(key, results);
  return results;
}

/** Free-text place search, biased to the area around the user. */
export async function searchPOIs(query, lat, lon) {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const key = `search:${trimmed.toLowerCase()}@${round(lat, 2)},${round(lon, 2)}`;
  const hit = cached(key, DAY);
  if (hit !== undefined) return hit;

  // ~4 km box around the user, matching the iOS search region.
  const span = 0.036;
  const viewbox = [lon - span, lat + span, lon + span, lat - span].join(',');
  const url =
    `${NOMINATIM}/search?q=${encodeURIComponent(trimmed)}&format=jsonv2` +
    `&limit=25&addressdetails=1&viewbox=${viewbox}&bounded=1`;
  const data = await serialize(() => fetchJSON(url));
  if (!Array.isArray(data)) return [];

  const results = data
    .map((item) => {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const address = item.address ?? {};
      // Nominatim puts the place's own name first in display_name.
      const name = item.name || item.display_name?.split(',')[0];
      if (!name) return null;
      return {
        name,
        locality: address.city ?? address.town ?? address.village ?? null,
        latitude,
        longitude,
        distance: haversine({ lat, lon }, { lat: latitude, lon: longitude }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);

  store(key, results);
  return results;
}
