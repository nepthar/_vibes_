# Jrnl — web

The Jrnl journal app is a 
single-page app plus an API. Same product: open-to-write, the typewriter
surface, the 5-minute entry lifecycle, journals, location tagging at five
granularities, inline media, and read mode's list / calendar heatmap / map.

## Running it

```bash
JRNL_HOST=any node server/index.js
```

Then open <http://localhost:8787>. `PORT` overrides the port. `JRNL_HOST` is
required and has no default — see [Deploying](#deploying); `any` is the
local-development setting.

There is **no build step and no dependencies** — the server is plain Node
(`node:sqlite`, built in since 22.5) and the client is ES modules served as-is.

```bash
npm test                      # entry lifecycle suite
npm run seed -- <user> --reset # dev history for checking read mode
```

### Harbor

This repo is a folder happ (`manifest.toml` at the root). Link or copy it into
your harbor apps directory as `jrnl.happ`, then:

```bash
harbor stage jrnl
harbor start jrnl
```

The published URL is `jrnl.<your-domain>`. Data (SQLite + media) lands in
harbor's data volume. Mint the first invite with
`node scripts/signup-token.js` against a running container (or locally with
`JRNL_DATA` pointed at that volume).

## Shape

```
manifest.toml  harbor happ definition
server/
  index.js     routing + static hosting
  db.js        schema (SQLite, in ./data)
  auth.js      signup / login / bearer tokens
  entries.js   journals, entries, blocks, the whole entry lifecycle
  geo.js       geocoding + place search proxy, cached
  media.js     upload and byte serving
  host.js      JRNL_HOST / HAPP_DOMAIN pinning
  rate.js      global token bucket
scripts/
  signup-token.js  mint a one-time invite
public/
  index.html    the whole page
  js/session.js the entry lifecycle, client-owned
  js/store.js   the local copy of the journal (IndexedDB)
  js/editor.js  the typewriter surface
  js/read.js    list / calendar / map
  js/minimap.js dependency-free slippy map
```

Data lives in `./data` (`jrnl.db` plus a `media/` directory). Deleting that
directory resets everything.

## Accounts

Sign-up is a made-up username, a password, and a **one-time signup token**
the operator minted — no email, no verification.

```bash
node scripts/signup-token.js   # token on stdout; expires in a week; deleted when used
```

Passwords must be at least 10 characters. There is no complexity rule to go
with it: length is what buys resistance, and character-class rules mostly buy
`Passw0rd!`.

The credentials are exchanged once for a session token (30-day expiry), which
the client keeps in `localStorage` and presents as `Authorization: Bearer
<token>` on every call. Passwords are stored as scrypt hashes with per-user
salts.

`/signup` and `/login` are the only endpoints reachable without an account, so
they are metered separately from everything else: **one attempt per second for
the whole process**, and every attempt takes a fixed 150 ms whether it
succeeds, fails on the password, or fails because there is no such user. The
fixed time matters as much as the limit — without it, a missing user answers in
0.6 ms and a real one in 23 ms, which is a free oracle for which usernames
exist here. Over the limit is `429` with `Retry-After: 1`.

One bucket for the whole process means a flood of login attempts can keep
*everyone* from signing in while it lasts. That is the deliberate trade: signing
in is rare, existing sessions are unaffected for 30 days, and the alternative is
leaving the guessing window open.

All data is scoped per user: journals, entries, and media are all keyed by
`user_id` and every query filters on it.

## What changed from the iOS design, and why

The product is the same; four things could not survive the platform change.

**Accounts and a server exist.** The original iOS design had no accounts and no
network. A hosted web app has to identify who is writing, so the SwiftData
store became a server-side SQLite database behind a token-authenticated API.
Same entities, same UUIDs, same block model.

**Media is uploaded or linked.** The iOS app stores a PhotoKit `localIdentifier` and
resolves the bytes from the device library. A browser has no photo library, so
picked files are uploaded (32 MB each) and a block stores the server's media
id — or a pasted `http(s)` image/video URL is stored as-is and hotlinked.
Everything built on top is unchanged: media is its own paragraph, rendered
full-width and aspect-fit with the height capped to the viewport, and a
missing asset still degrades to the quiet "media no longer available"
placeholder.

**Geocoding comes from OpenStreetMap.** `CLGeocoder` and `MKLocalSearch` have
no web equivalent, so reverse geocoding and centroid lookups go to Nominatim
and the nearby-places list to Overpass — through the server, so calls are
cached, rate-limited to Nominatim's one-per-second policy, and identified by a
proper User-Agent. Set `JRNL_GEO_UA` before deploying anywhere real. Every geo
call degrades to null / empty on failure; the app never blocks writing on it.

Two things guard that proxy, and they are the same guarantee from different
angles. **Every geo response takes a fixed two seconds**, hit or miss or
failure: the cache is shared across users, and a hit returning in under a
millisecond against a miss taking a second and a half would let any account
probe where *other* people have been writing. And **at most 10 geo requests are
in flight at once** (`JRNL_GEO_QUEUE`), past which the answer is `429` with
`Retry-After: 1` — at one upstream call per 1.1s an unbounded queue turns a
burst into minutes of latency for everyone, holding a socket per waiting
request.

The slot is claimed for the whole request and *before* the cache is read, which
looks wasteful and is not: gate after the cache and a `429` starts meaning
"this coordinate is not cached", handing back the very oracle the two-second
floor exists to close. Load decides who is refused; never what is in the cache.

**The map is hand-rolled.** MapKit is replaced by a small Web Mercator tile map
(`js/minimap.js`) with pan, zoom, and count-badged clustering. It was written
rather than vendored to keep the app a single self-hosted bundle with no CDN.

Two smaller platform notes:

- **The keyboard cannot be raised programmatically** on mobile browsers without
  a user gesture, so a cold load lands with the caret placed and the keyboard
  appearing on first tap. Everything else about open-to-write is intact.

## The entry lifecycle

**The client owns it.** It decides when an entry begins and when it is
finished, against its own clock — for a journal the user's wall clock is the
right authority. The server stores what it is told, including a sliding
finalize deadline so a closed tab still reaches the journal.

There are two operations:

```
PUT  /api/current   { deviceId, entryId, journalId, contents, location,
                      startedAt, timeZone, clientTime, finalizeIn }
POST /api/entries   { id, journalId, contents, location, createdAt, timeZone }
```

`finalizeIn` is seconds from now. The server converts it to an absolute
`finalize_at` on every scratch update; each update slides the deadline forward.
When the client starts a *new* `entryId` in the same device slot, the previous
draft is finalized immediately (committed if it has real content, otherwise
discarded).

`/current` is **scratch space, one slot per device**. It exists so a crash or a
closed tab costs nothing. A commit carries the entry's whole content, so no
slot is consulted to produce a journal entry except when the janitor (or a
new-draft rollover) finalizes what was last posted. Losing an update costs at
most the last few seconds of typing.

`/entries` commits. The client generates the entry's UUID, so the request is
**idempotent**: a retry after a lost response finds the entry already there and
changes nothing. It is also self-contained, so it does not matter what order it
arrives in relative to the last `/current`. Empty drafts are never saved: text
is trimmed, and a draft needs a media block or at least three non-whitespace
characters. Clearing a blank draft still uses `DELETE /api/current`.

### Why there are no conflicts

- **Scratch is per device.** Two devices writing at once each have their own
  slot, so they never contend. There is no conflict to resolve because there is
  nothing shared to conflict over. Within one device, an update stamped earlier
  than the one already stored is refused, so a stale tab cannot clobber a live
  one.
- **Committed entries are immutable and never deleted.** That makes the journal
  a grow-only set: reconciling two devices is a union, not a negotiation.
- **The staleness check runs before the next keystroke is accepted.** A tab
  suspended for an hour commits what was written before it slept and opens a
  fresh entry, and the keystroke lands in the new one. Nothing ever has to be
  pulled apart afterwards. This happens in `beforeinput`, which is the only
  moment where the old entry's content is still exactly what it should be.

`JRNL_TIMEOUT_MS` overrides the 5-minute policy for testing (the server ships it
to the client on boot, so the policy still lives in one place);
`JRNL_DRAFT_DEBOUNCE_MS` overrides how soon after a keystroke scratch is posted.

### The janitor

The client still finishes entries while it is awake. The janitor commits any
draft whose `finalize_at` has passed — the same deadline the client last posted
— so writing is not lost when a tab never returns. It also runs on `/state` and
`/entries`, and on a short background interval (`JRNL_JANITOR_MS`, default 30s).
Legacy rows without `finalize_at` still fall back to the 24-hour orphan window
(`JRNL_ORPHAN_MS`).

Blank drafts are discarded, never saved. A late client `POST /entries` after
the janitor already committed is a no-op (idempotent by entry id).

Committed entries are immutable. The one exception, as in the iOS app, is
finishing a pending geocode — system bookkeeping, not a content edit — and even
that is refused unless the entry is already tagged.

## The local copy

Read mode renders from an IndexedDB copy of the journal, so opening the app and
switching to the calendar or map never waits on the network (reads measure well
under a millisecond). The server is refreshed from in the background.

A commit is written locally first and posted after, so an entry appears in the
journal instantly and survives a dropped connection: anything the server has not
acknowledged stays queued and is retried on the next load, on reconnect, and
when the tab is refocused.

**The server remains the source of truth.** Browsers evict IndexedDB under
storage pressure, and Safari clears script-writable storage for sites left
unvisited for about a week — which is exactly the access pattern of a journal
you open on Sundays. This is a cache and a write buffer, never the record. The
local copy is scoped per user and destroyed on sign-out.

Media is deliberately *not* held locally: text is small forever (ten years of
daily writing is ~13 MB), but one video would exceed the entire text corpus.
Media stays remote, fetched on demand.

## Deploying

The server is a single process with a SQLite file, so it wants one machine with
a persistent disk, sitting behind a reverse proxy that terminates TLS. The
session token is a bearer credential and must not travel over plain HTTP.

Set `JRNL_HOST` to the public hostname (e.g. `journal.example.com`). The
process then refuses any request whose `Host` header is not that name — raw
IPs, internal names, DNS rebinding. The proxy must forward the public Host
header (nginx does this by default).

**`JRNL_HOST` is required and the process will not start without it.** It is
the only source — there is no fallback to `HAPP_DOMAIN` or anything else,
because a guard that silently switches itself off when a variable goes missing
is not a guard. Set it to `any` to accept every Host; that is for local
development, and it says so on stdout at boot. Under harbor, set the `host`
config to the published `jrnl.<your-domain>`.

Responses carry a `Content-Security-Policy` (`script-src 'self'`, no framing,
no `base-uri`, no `form-action`), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. HSTS is sent
whenever a real host is pinned, and omitted under `JRNL_HOST=any` so local
http development still works. `img-src`/`media-src` allow `https:` because a
pasted media URL is hotlinked from wherever it came from; `style-src` allows
inline because a couple of sheets set a style attribute through `innerHTML`.

A global token bucket covers **every** request, static files included: 30 rps
with a burst of 80, which is enough for ten devices keeping an entry open at
once (scratch posts every 800ms are 12.5 rps, plus cold loads, commits, and
geo). `JRNL_RATE_RPS` / `JRNL_RATE_BURST` override it.

Note what that bucket is and is not. It is one bucket for the whole process,
with no per-client dimension, so it bounds total load but does **not** stop one
client from spending everyone's budget — 200 requests from a single source is
enough to hand every other user a `429`. Per-IP limiting belongs at the reverse
proxy (nginx `limit_req_zone $binary_remote_addr`), which is the layer that
knows the real client address; this process never sees it, and deliberately
does not trust `X-Forwarded-For`.

`JRNL_DATA` relocates the data directory (default `./data`). That directory
holds everything worth backing up, including the WAL and `media/`. Create the
first account with `node scripts/signup-token.js`, then the token on the sign-up
screen. Set `JRNL_GEO_UA` to an identifying User-Agent before pointing
Nominatim at a real deployment.
