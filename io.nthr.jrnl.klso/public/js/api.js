/**
 * The API client. A session token is obtained once from made-up credentials
 * and presented on every call; nothing else is needed to identify the user.
 */

const TOKEN_KEY = 'jrnl.token';
const DEVICE_KEY = 'jrnl.device';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the in-memory copy still lasts this page.
  }
}

/**
 * `crypto.randomUUID` exists only in a secure context. Desktop Firefox on
 * `http://localhost` is one; Safari on a phone at `http://192.168.x.x` is not,
 * and a throw while this module evaluates would leave both screens hidden.
 */
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let token = storageGet(TOKEN_KEY);

/**
 * A stable id for this browser. Scratch space is kept per device, so two
 * devices writing at once each have their own slot and never contend — there
 * is no conflict to resolve because there is no shared thing to conflict over.
 */
export const deviceId = (() => {
  let id = storageGet(DEVICE_KEY);
  if (!id) {
    id = uuid();
    storageSet(DEVICE_KEY, id);
  }
  return id;
})();

export const hasToken = () => !!token;
export const getToken = () => token;

export function setToken(value) {
  token = value;
  storageSet(TOKEN_KEY, value);
}

/** Raised when the token is missing or expired, so the app can show sign-in. */
export class AuthError extends Error {}

async function request(method, path, { body, headers = {}, raw } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });

  if (response.status === 401) {
    const detail = await response.json().catch(() => ({}));
    // Login's 401 is "those credentials are wrong", not a dropped session.
    if (path === '/login') {
      throw new Error(detail.error ?? 'Invalid username or password');
    }
    setToken(null);
    throw new AuthError(detail.error ?? 'Session expired');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `Request failed (${response.status})`);
  }
  return response;
}

const json = async (...args) => (await request(...args)).json();

export const api = {
  /**
   * An account token carries the username it was minted for: reading it back
   * says whose account is about to be set up, and whether that account already
   * exists (a reset) or not (a new one). Redeeming it is the second call.
   */
  accountToken: (accountToken) => json('POST', '/account/lookup', { body: { accountToken } }),
  setUpAccount: (accountToken, password) =>
    json('POST', '/account/setup', { body: { accountToken, password } }),
  login: (username, password) => json('POST', '/login', { body: { username, password } }),
  logout: () => json('POST', '/logout').catch(() => {}),

  state: () => json('GET', `/state?deviceId=${encodeURIComponent(deviceId)}`),
  createJournal: (name) => json('POST', '/journals', { body: { name } }),
  setPreferences: (preferences) =>
    json('PATCH', '/preferences', { body: { deviceId, ...preferences } }),

  /** Writing in progress — this device's scratch slot. */
  updateDraft: (payload) => json('PUT', '/current', { body: payload }),
  discardDraft: () => json('DELETE', `/current?deviceId=${encodeURIComponent(deviceId)}`),

  /**
   * Commits an entry to the journal. The id is the client's and the whole
   * content is in the request, so this is idempotent: a retry after a lost
   * response finds the entry already there and changes nothing.
   */
  commitEntry: (entry) =>
    json('POST', '/entries', {
      body: {
        deviceId,
        id: entry.id,
        journalId: entry.journalId,
        contents: entry.blocks,
        location: entry.location,
        createdAt: entry.createdAt,
        lastInteractionAt: entry.lastInteractionAt,
        timeZone: entry.timeZoneId,
      },
    }),

  /** Finishes a geocode that was still pending when the entry was committed. */
  resolveEntryLocation: (entryId, location) =>
    json('PUT', `/entries/${entryId}/location`, { body: { location } }),
  setPublished: (entryId, published) =>
    json('PUT', `/entries/${entryId}/published`, { body: { published: !!published } }),
  entries: (journalId) => json('GET', `/entries?journalId=${encodeURIComponent(journalId)}`),

  uploadMedia: (file, { pixelWidth, pixelHeight, duration }) =>
    json('POST', '/media', {
      raw: file,
      headers: {
        'Content-Type': file.type,
        ...(pixelWidth ? { 'X-Pixel-Width': String(pixelWidth) } : {}),
        ...(pixelHeight ? { 'X-Pixel-Height': String(pixelHeight) } : {}),
        ...(duration ? { 'X-Duration': String(duration) } : {}),
      },
    }),

  reverseGeocode: (lat, lon) => json('GET', `/geo/reverse?lat=${lat}&lon=${lon}`),
  centroid: (name) => json('GET', `/geo/centroid?name=${encodeURIComponent(name)}`),
  places: (lat, lon, query = '') =>
    json('GET', `/geo/places?lat=${lat}&lon=${lon}&q=${encodeURIComponent(query)}`),
};

/**
 * Media bytes need the bearer token, which an `<img src>` cannot send — so
 * assets are fetched and handed to the DOM as object URLs. Resolved URLs are
 * memoised per asset for the life of the page.
 */
const mediaURLs = new Map();

export function mediaURL(assetId) {
  if (!mediaURLs.has(assetId)) {
    const promise = request('GET', `/media/${assetId}`)
      .then((response) => response.blob())
      .then((blob) => URL.createObjectURL(blob))
      .catch((error) => {
        // A miss is remembered as "gone" so the placeholder is stable, but an
        // expired session must not be mistaken for missing media.
        if (error instanceof AuthError) mediaURLs.delete(assetId);
        return null;
      });
    mediaURLs.set(assetId, promise);
  }
  return mediaURLs.get(assetId);
}
