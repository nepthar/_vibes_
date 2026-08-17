import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, atLeast, notFound, readJSON, sendJSON, tooManyRequests } from './http.js';
import {
  authenticate,
  login,
  logout,
  lookupAccountToken,
  publicUser,
  setUpAccount,
  tokenFrom,
} from './auth.js';
import * as store from './entries.js';
import * as geo from './geo.js';
import { serveMedia, uploadMedia } from './media.js';
import { ANY_HOST, hostAllowed, requireExpectedHost } from './host.js';
import { authLimiter, limiter, reserve } from './rate.js';
import { publishedDir } from './db.js';
import { startPublishScheduler } from './publish.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT ?? 8787);

// Refuses to start without an explicit JRNL_HOST, so the Host guard can never
// be off by accident. `any` is the deliberate local-development opt-out.
const EXPECTED_HOST = requireExpectedHost();
const PINNED = EXPECTED_HOST.toLowerCase() !== ANY_HOST;

/**
 * Every credential check takes at least this long, whether it succeeds, fails
 * on a wrong password, or fails because there is no such user. Without it the
 * three are ~23ms / ~23ms / ~0.6ms apart, and the fast path is a free oracle
 * for which usernames exist on this instance.
 */
const AUTH_FLOOR_MS = 150;

/** The endpoints that take a secret without a session behind it. */
const CREDENTIAL_PATHS = new Set(['/login', '/account/lookup', '/account/setup']);

/**
 * Same trick for geocoding. The cache is shared across users by design, so a
 * cache hit returning in under a millisecond while a miss takes a second and a
 * half would let any account probe where *other* people have been writing.
 * Every geo answer takes two seconds and tells the caller nothing else.
 */
const GEO_FLOOR_MS = 2000;

const SECURITY_HEADERS = {
  // `img-src`/`media-src` allow https: because a pasted media URL is
  // hotlinked from wherever the user pasted it from. `style-src` allows
  // inline because a few sheets set a style attribute through innerHTML;
  // script-src stays strict, which is the half that matters.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // The session token is a bearer credential; it must never travel in clear.
  // Skipped when the host is unpinned, since that is local http development.
  ...(PINNED ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

// MARK: - Static hosting

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.webmanifest', 'application/manifest+json'],
]);

async function sendFile(res, path, { cacheControl = 'public, max-age=31536000, immutable' } = {}) {
  const extension = extname(path).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
  createReadStream(path).pipe(res);
}

async function serveStatic(res, pathname) {
  // Any unknown path falls back to index.html — it is a single page app, and
  // the page itself decides what to show. `/p/*` never reaches here.
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  let file = relative === '' ? 'index.html' : relative;
  let path = join(publicDir, file);
  if (!path.startsWith(publicDir)) path = join(publicDir, 'index.html');

  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new Error('directory');
  } catch {
    path = join(publicDir, 'index.html');
  }

  // The private app is small and changes as a unit; revalidate so a deploy
  // does not require a hard refresh.
  await sendFile(res, path, { cacheControl: 'no-cache' });
}

/**
 * Public published blogs live under `/p/<username>/…`. No SPA fallback: a
 * missing tree is a hard 404. `/p` itself is also 404 (no directory index).
 *
 * `/p/<user>` (no trailing slash) redirects to `/p/<user>/` so relative URLs
 * in older trees still resolve; new trees use root-relative `/p/<user>/…` links.
 */
async function servePublished(res, pathname) {
  if (pathname === '/p' || pathname === '/p/') throw notFound();

  // Directory index without a trailing slash: /p/alice → /p/alice/
  const bareUser = /^\/p\/([^/]+)$/.exec(pathname);
  if (bareUser) {
    const dir = join(publishedDir, bareUser[1]);
    if (!dir.startsWith(publishedDir)) throw notFound();
    try {
      const info = await stat(dir);
      if (info.isDirectory()) {
        res.writeHead(301, { Location: `${pathname}/`, 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }
    } catch {
      throw notFound();
    }
  }

  const trimmed = pathname.replace(/\/+$/, '') || '/p';
  const relative = normalize(trimmed.slice(2)).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  if (!relative || relative.startsWith('.')) throw notFound();

  const base = join(publishedDir, relative);
  if (!base.startsWith(publishedDir)) throw notFound();

  const candidates = [];
  try {
    const info = await stat(base);
    if (info.isDirectory()) candidates.push(join(base, 'index.html'));
    else candidates.push(base);
  } catch {
    candidates.push(`${base}.html`);
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith(publishedDir)) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        // HTML trees are rewritten on each publish job (index lists change);
        // media/css under a slug are content-addressed and stable.
        const cacheControl = /\.html$/i.test(candidate)
          ? 'public, max-age=60'
          : undefined;
        await sendFile(res, candidate, cacheControl ? { cacheControl } : {});
        return;
      }
    } catch {
      // try next
    }
  }

  throw notFound();
}

// MARK: - API

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Everything the app needs on load: who you are, your journals, this device's
 * scratch slot, and the lifecycle policy it should apply. Reloading resumes
 * writing in progress exactly where it was left.
 */
function bootstrapState(user, deviceId) {
  const journals = store.listJournals(user);
  const active =
    journals.find((journal) => journal.id === user.active_journal_id) ?? journals[0];
  store.sweepOrphanedDrafts(user);
  return {
    user: { ...publicUser(user), activeJournalId: active?.id ?? null },
    journals,
    activeJournalId: active?.id ?? null,
    draft: store.currentDraft(user, deviceId),
    policy: {
      finishAfterMs: store.TIMEOUT_MS,
      draftDebounceMs: store.DRAFT_DEBOUNCE_MS,
    },
  };
}

/**
 * One geocoding request: a queue slot for its whole duration, and a fixed
 * two seconds on the wire whatever happens inside — hit, miss, upstream
 * failure, or refusal. Both halves are the same guarantee from different
 * angles: neither the clock nor the status code may reveal what the shared
 * cache holds, because what it holds is where other people have been writing.
 */
const geoRequest = (task) =>
  atLeast(GEO_FLOOR_MS, async () => {
    const release = reserve();
    try {
      return await task();
    } finally {
      release();
    }
  });

async function handleAPI(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const { method } = req;

  // Unauthenticated credential checks. These are the only endpoints an
  // attacker can hammer without an account, so they get their own bucket and
  // a fixed response time on top of the global limit. The account-token pair
  // belongs here too: both take a secret handed out by the operator, and
  // `/account/lookup` answers with a username, so it is metered and padded
  // exactly like a password guess.
  if (method === 'POST' && CREDENTIAL_PATHS.has(path)) {
    if (!authLimiter.take()) throw tooManyRequests('Too many attempts');
    const body = await readJSON(req);
    const result = await atLeast(AUTH_FLOOR_MS, async () => {
      if (path === '/login') return login(body);
      if (path === '/account/lookup') return lookupAccountToken(body.accountToken);
      return setUpAccount(body);
    });
    return sendJSON(res, 200, result);
  }

  if (method === 'POST' && path === '/logout') {
    logout(tokenFrom(req));
    return sendJSON(res, 200, { ok: true });
  }

  // Everything below presents the session token on each call.
  const user = authenticate(req);

  if (method === 'GET' && path === '/state') {
    return sendJSON(res, 200, bootstrapState(user, url.searchParams.get('deviceId')));
  }

  if (method === 'POST' && path === '/journals') {
    const { name } = await readJSON(req);
    const journal = store.createJournal(user, name);
    return sendJSON(res, 200, { journal, journals: store.listJournals(user) });
  }

  if (method === 'PATCH' && path === '/preferences') {
    const body = await readJSON(req);
    const preferences = store.setPreferences(user, body);
    // Switching journals mid-entry moves the draft with the choice.
    const draft = body.activeJournalId
      ? store.reassignDraft(user, body.deviceId, preferences.activeJournalId)
      : store.currentDraft(user, body.deviceId);
    return sendJSON(res, 200, { ...preferences, draft });
  }

  // Writing in progress. Best-effort scratch: nothing here is needed to
  // produce a journal entry, so a lost update costs a few seconds of typing.
  if (method === 'PUT' && path === '/current') {
    return sendJSON(res, 200, store.updateDraft(user, await readJSON(req)));
  }

  if (method === 'DELETE' && path === '/current') {
    store.discardDraft(user, url.searchParams.get('deviceId'));
    return sendJSON(res, 200, { ok: true });
  }

  // Commit. The client chose the id and sends the whole entry, so a retry
  // after a lost response is a no-op rather than a duplicate.
  if (method === 'POST' && path === '/entries') {
    const { entry, created } = store.commitEntry(user, await readJSON(req));
    return sendJSON(res, created ? 201 : 200, { entry, created });
  }

  const locationMatch = /^\/entries\/([\w-]+)\/location$/.exec(path);
  if (method === 'PUT' && locationMatch) {
    const { location } = await readJSON(req);
    return sendJSON(res, 200, {
      entry: store.resolveEntryLocation(user, locationMatch[1], location ?? null),
    });
  }

  const publishedMatch = /^\/entries\/([\w-]+)\/published$/.exec(path);
  if (method === 'PUT' && publishedMatch) {
    const body = await readJSON(req);
    return sendJSON(res, 200, {
      entry: store.setEntryPublished(user, publishedMatch[1], body.published),
    });
  }

  if (method === 'GET' && path === '/entries') {
    const journalId = url.searchParams.get('journalId') ?? user.active_journal_id;
    return sendJSON(res, 200, { entries: store.listEntries(user, journalId) });
  }

  if (method === 'POST' && path === '/media') {
    return sendJSON(res, 200, await uploadMedia(req, user));
  }

  const mediaMatch = /^\/media\/([\w-]+)$/.exec(path);
  if (method === 'GET' && mediaMatch) {
    return serveMedia(req, res, user, mediaMatch[1]);
  }

  // Geocoding and place search, proxied so we can cache and rate-limit.
  if (method === 'GET' && path === '/geo/reverse') {
    return sendJSON(
      res,
      200,
      await geoRequest(() => {
        const lat = number(url.searchParams.get('lat'));
        const lon = number(url.searchParams.get('lon'));
        if (lat === null || lon === null) return { city: null, neighborhood: null };
        return geo.resolveNames(lat, lon);
      })
    );
  }

  if (method === 'GET' && path === '/geo/centroid') {
    return sendJSON(
      res,
      200,
      await geoRequest(async () => {
        const name = url.searchParams.get('name') ?? '';
        return { centroid: name ? await geo.centroid(name) : null };
      })
    );
  }

  if (method === 'GET' && path === '/geo/places') {
    return sendJSON(
      res,
      200,
      await geoRequest(async () => {
        const lat = number(url.searchParams.get('lat'));
        const lon = number(url.searchParams.get('lon'));
        const query = url.searchParams.get('q') ?? '';
        if (lat === null || lon === null) return { places: [] };
        return {
          places: query.trim()
            ? await geo.searchPOIs(query, lat, lon)
            : await geo.nearbyPOIs(lat, lon),
        };
      })
    );
  }

  throw notFound();
}

const server = createServer(async (req, res) => {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (!hostAllowed(req.headers.host, EXPECTED_HOST)) {
      return sendJSON(res, 421, { error: 'Unknown host' });
    }
    if (!limiter.take()) {
      res.setHeader('Retry-After', '1');
      return sendJSON(res, 429, { error: 'Slow down' });
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleAPI(req, res, url);
    } else if (url.pathname === '/p' || url.pathname.startsWith('/p/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound();
      await servePublished(res, url.pathname);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(res, url.pathname);
    } else {
      throw notFound();
    }
  } catch (error) {
    if (res.headersSent) return res.end();
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 500) console.error(`${req.method} ${req.url}`, error);
    if (error instanceof ApiError && error.retryAfter != null) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    sendJSON(res, status, { error: status === 500 ? 'Something went wrong' : error.message });
  }
});

server.listen(PORT, () => {
  const origin = `http://localhost:${PORT}`;
  console.log(
    PINNED
      ? `Jrnl running at ${origin} (accepting Host: ${EXPECTED_HOST})`
      : `Jrnl running at ${origin} (JRNL_HOST=any — every Host accepted, local development only)`
  );
});

// Background janitor: commit drafts whose finalize_at has passed, even when no
// client is hitting /state or /entries. Opportunistic sweeps on those routes
// still run too.
setInterval(() => {
  try {
    store.sweepDueDrafts();
  } catch (error) {
    console.error('janitor', error);
  }
}, store.JANITOR_MS).unref();

startPublishScheduler().unref();
