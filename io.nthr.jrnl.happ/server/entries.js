import { db, uuid, now } from './db.js';
import { badRequest, notFound } from './http.js';

/**
 * An entry is finished after 2 minutes with no interaction (temporary for
 * testing; restore to 5 minutes). The client applies this against its own
 * clock and tells the server the result; these are shipped to it on boot so
 * the policy still lives in one place, and so it stays tunable without a
 * redeploy of the page.
 */
export const TIMEOUT_MS = Number(process.env.JRNL_TIMEOUT_MS) || 2 * 60 * 1000;

/** How long after a keystroke the client posts the scratch slot. */
export const DRAFT_DEBOUNCE_MS = Number(process.env.JRNL_DRAFT_DEBOUNCE_MS) || 800;

const q = {
  journals: db.prepare('SELECT * FROM journals WHERE user_id = ? ORDER BY created_at'),
  journalById: db.prepare('SELECT * FROM journals WHERE id = ? AND user_id = ?'),
  journalByName: db.prepare(
    'SELECT * FROM journals WHERE user_id = ? AND name = ? COLLATE NOCASE'
  ),
  insertJournal: db.prepare(
    'INSERT INTO journals (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
  ),

  entryById: db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?'),
  committedEntries: db.prepare(
    `SELECT * FROM entries
     WHERE user_id = ? AND journal_id = ?
     ORDER BY created_at DESC`
  ),
  insertEntry: db.prepare(
    `INSERT INTO entries
       (id, user_id, journal_id, created_at, time_zone_id, last_interaction_at, received_at,
        loc_granularity, loc_display_name, loc_latitude, loc_longitude, loc_resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),

  draftFor: db.prepare('SELECT * FROM drafts WHERE user_id = ? AND device_id = ?'),
  draftsFor: db.prepare('SELECT * FROM drafts WHERE user_id = ?'),
  dueDrafts: db.prepare(
    `SELECT * FROM drafts
     WHERE (finalize_at IS NOT NULL AND finalize_at <= ?)
        OR (finalize_at IS NULL AND received_at <= ?)`
  ),
  upsertDraft: db.prepare(
    `INSERT INTO drafts
       (user_id, device_id, entry_id, journal_id, content, location, started_at,
        time_zone_id, client_time, received_at, finalize_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       entry_id = excluded.entry_id,
       journal_id = excluded.journal_id,
       content = excluded.content,
       location = excluded.location,
       started_at = excluded.started_at,
       time_zone_id = excluded.time_zone_id,
       client_time = excluded.client_time,
       received_at = excluded.received_at,
       finalize_at = excluded.finalize_at`
  ),
  deleteDraft: db.prepare('DELETE FROM drafts WHERE user_id = ? AND device_id = ?'),
  reassignDraft: db.prepare(
    'UPDATE drafts SET journal_id = ? WHERE user_id = ? AND device_id = ?'
  ),
  setLocation: db.prepare(
    `UPDATE entries
     SET loc_granularity = ?, loc_display_name = ?, loc_latitude = ?, loc_longitude = ?, loc_resolved = ?
     WHERE id = ?`
  ),
  setPublished: db.prepare(
    'UPDATE entries SET published = ?, publish_slug = ? WHERE id = ? AND user_id = ?'
  ),
  takenSlugs: db.prepare(
    `SELECT publish_slug AS slug FROM entries
     WHERE user_id = ? AND publish_slug IS NOT NULL AND id != ?`
  ),
  touchPublishChange: db.prepare('UPDATE publish_meta SET change_at = ? WHERE id = 1'),

  blocksFor: db.prepare('SELECT * FROM blocks WHERE entry_id = ? ORDER BY idx'),
  blocksForUser: db.prepare(
    `SELECT blocks.* FROM blocks
     JOIN entries ON entries.id = blocks.entry_id
     WHERE entries.user_id = ? AND entries.journal_id = ?
     ORDER BY blocks.entry_id, blocks.idx`
  ),
  deleteBlocks: db.prepare('DELETE FROM blocks WHERE entry_id = ?'),
  insertBlock: db.prepare(
    `INSERT INTO blocks (id, entry_id, idx, kind, text, asset_id, url, media_type, pixel_width, pixel_height, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),

  setPrefs: db.prepare(
    'UPDATE users SET active_journal_id = ?, remembered_granularity = ? WHERE id = ?'
  ),
};

// MARK: - Serialization

function serializeBlock(row) {
  if (row.kind === 'text') return { kind: 'text', text: row.text ?? '' };
  const block = {
    kind: 'media',
    mediaType: row.media_type ?? 'photo',
    pixelWidth: row.pixel_width ?? 0,
    pixelHeight: row.pixel_height ?? 0,
    duration: row.duration ?? null,
  };
  if (row.url) block.url = row.url;
  else block.assetId = row.asset_id;
  return block;
}

function serializeEntry(row, blocks) {
  return {
    id: row.id,
    journalId: row.journal_id,
    createdAt: row.created_at,
    timeZoneId: row.time_zone_id,
    lastInteractionAt: row.last_interaction_at,
    published: !!row.published,
    publishSlug: row.publish_slug ?? null,
    blocks: blocks.map(serializeBlock),
    location: row.loc_granularity
      ? {
          granularity: row.loc_granularity,
          displayName: row.loc_display_name,
          latitude: row.loc_latitude,
          longitude: row.loc_longitude,
          isResolved: !!row.loc_resolved,
        }
      : null,
  };
}

export const serializeJournal = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

const entryWithBlocks = (row) => serializeEntry(row, q.blocksFor.all(row.id));

// MARK: - Journals

export function listJournals(user) {
  return q.journals.all(user.id).map(serializeJournal);
}

/**
 * Create + switch is the whole of journal management. Names are unique
 * case-insensitively, so an existing match is returned rather than duplicated.
 */
export function createJournal(user, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) throw badRequest('Journal name cannot be empty');
  if (name.length > 40) throw badRequest('Journal name is too long');
  const existing = q.journalByName.get(user.id, name);
  if (existing) return serializeJournal(existing);
  const journal = { id: uuid(), user_id: user.id, name, created_at: now() };
  q.insertJournal.run(journal.id, user.id, name, journal.created_at);
  return serializeJournal(journal);
}

function requireJournal(user, journalId) {
  const journal = q.journalById.get(String(journalId ?? ''), user.id);
  if (!journal) throw notFound('No such journal');
  return journal;
}

export function setPreferences(user, { activeJournalId, rememberedGranularity }) {
  const active = activeJournalId ? requireJournal(user, activeJournalId).id : user.active_journal_id;
  const levels = ['off', 'city', 'neighborhood', 'poi', 'exact'];
  const level = levels.includes(rememberedGranularity)
    ? rememberedGranularity
    : user.remembered_granularity;
  q.setPrefs.run(active, level, user.id);
  return { activeJournalId: active, rememberedGranularity: level };
}

// MARK: - Scratch space and committing
//
// The client owns the lifecycle. It decides when an entry begins and when it
// is finished, using its own clock, and posts that decision as `finalize_in`
// (seconds from now) on every scratch update. The server stores the absolute
// deadline and the janitor commits anything whose deadline has passed. The
// client still commits directly via POST /entries when it is awake; the
// janitor is how a closed tab still reaches the journal.
//
// `drafts` is scratch: one slot per device. A commit carries the entry's full
// content, so no slot is ever consulted to produce a journal entry — except
// when the janitor (or a new-draft rollover) finalizes what was last posted.

/** Fallback if a draft somehow has no finalize_at (legacy rows). */
export const ORPHAN_MS = Number(process.env.JRNL_ORPHAN_MS) || 24 * 60 * 60 * 1000;

/** How often the process-wide janitor looks for due drafts. */
export const JANITOR_MS = Number(process.env.JRNL_JANITOR_MS) || 30_000;

const serializeDraft = (row) => ({
  deviceId: row.device_id,
  entryId: row.entry_id,
  journalId: row.journal_id,
  blocks: parseJSON(row.content, []),
  location: parseJSON(row.location, null),
  startedAt: row.started_at,
  timeZoneId: row.time_zone_id,
  clientTime: row.client_time,
  finalizeAt: row.finalize_at ?? null,
});

function parseJSON(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const requireId = (value, what) => {
  const id = String(value ?? '');
  if (!/^[\w-]{8,64}$/.test(id)) throw badRequest(`Invalid ${what}`);
  return id;
};

/** The scratch slot for one device, if it has one. */
export function currentDraft(user, deviceId) {
  if (!deviceId) return null;
  const row = q.draftFor.get(user.id, String(deviceId));
  return row ? serializeDraft(row) : null;
}

/**
 * Records writing in progress. Refuses an update stamped earlier than the one
 * already stored for the same entry: with a slot per device that only happens
 * if the same device has two tabs open, and the stale one must not clobber the
 * live one. A different entryId means the client has moved on — the previous
 * draft is finalized first.
 */
export function updateDraft(user, payload) {
  const deviceId = requireId(payload.deviceId, 'deviceId');
  const entryId = requireId(payload.entryId, 'entryId');
  const journal = requireJournal(user, payload.journalId);
  const blocks = normalizeContents(payload.contents);
  const clientTime = Number(payload.clientTime);
  if (!Number.isFinite(clientTime)) throw badRequest('clientTime is required');

  const finalizeIn = Number(payload.finalizeIn);
  if (!Number.isFinite(finalizeIn) || finalizeIn < 0) {
    throw badRequest('finalizeIn is required');
  }
  const receivedAt = now();
  const finalizeAt = receivedAt + Math.ceil(finalizeIn) * 1000;

  const existing = q.draftFor.get(user.id, deviceId);
  if (existing && existing.entry_id === entryId && existing.client_time > clientTime) {
    return { accepted: false, draft: serializeDraft(existing) };
  }
  if (existing && existing.entry_id !== entryId) {
    finalizeDraftRow(user, existing);
  }

  const startedAt = Number(payload.startedAt) || clientTime;
  q.upsertDraft.run(
    user.id,
    deviceId,
    entryId,
    journal.id,
    JSON.stringify(blocks),
    payload.location ? JSON.stringify(payload.location) : null,
    startedAt,
    typeof payload.timeZone === 'string' && payload.timeZone ? payload.timeZone : 'UTC',
    clientTime,
    receivedAt,
    finalizeAt
  );
  return { accepted: true, draft: currentDraft(user, deviceId) };
}

export function discardDraft(user, deviceId) {
  if (deviceId) q.deleteDraft.run(user.id, String(deviceId));
}

/**
 * Commits an entry to the journal. The client chose the id and sends the whole
 * content, which makes this idempotent — a retry after a lost response finds
 * the entry already there and changes nothing — and independent of whatever
 * the scratch slot happens to hold.
 */
export function commitEntry(user, payload) {
  const id = requireId(payload.id, 'entry id');
  const existing = q.entryById.get(id, user.id);
  if (existing) {
    // Already committed. Entries are immutable, so this is simply the answer.
    if (payload.deviceId) clearSlotFor(user, payload.deviceId, id);
    return { entry: entryWithBlocks(existing), created: false };
  }

  const journal = requireJournal(user, payload.journalId);
  const blocks = normalizeContents(payload.contents);
  if (isBlank(blocks)) throw badRequest('An empty entry is never saved');

  const createdAt = Number(payload.createdAt) || now();
  const lastInteractionAt = Number(payload.lastInteractionAt) || createdAt;
  const location = normalizeLocation(payload.location);

  db.exec('BEGIN');
  try {
    q.insertEntry.run(
      id,
      user.id,
      journal.id,
      createdAt,
      typeof payload.timeZone === 'string' && payload.timeZone ? payload.timeZone : 'UTC',
      lastInteractionAt,
      now(),
      location?.granularity ?? null,
      location?.displayName ?? null,
      location?.latitude ?? null,
      location?.longitude ?? null,
      location?.isResolved ? 1 : 0
    );
    rewriteBlocks(id, blocks);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (payload.deviceId) clearSlotFor(user, payload.deviceId, id);
  return { entry: entryWithBlocks(q.entryById.get(id, user.id)), created: true };
}

/** Only clears the slot if it still holds the entry that was just committed. */
function clearSlotFor(user, deviceId, entryId) {
  const slot = q.draftFor.get(user.id, String(deviceId));
  if (slot && slot.entry_id === entryId) q.deleteDraft.run(user.id, String(deviceId));
}

/**
 * Turns a draft row into a journal entry (or discards it if blank) and clears
 * the slot. Used by the janitor and when a device starts a new entryId.
 */
function finalizeDraftRow(user, row) {
  const draft = serializeDraft(row);
  q.deleteDraft.run(user.id, row.device_id);
  if (isBlank(draft.blocks)) return null;
  const { entry } = commitEntry(user, {
    id: draft.entryId,
    journalId: draft.journalId,
    contents: draft.blocks,
    createdAt: draft.startedAt,
    lastInteractionAt: draft.clientTime,
    timeZone: draft.timeZoneId,
    location: draft.location,
  });
  return entry.id;
}

function draftIsDue(row, at) {
  if (row.finalize_at != null) return row.finalize_at <= at;
  return at - row.received_at >= ORPHAN_MS;
}

/**
 * The janitor. Commits any of this user's drafts whose finalize_at has passed
 * (or, for legacy rows without one, that have sat untouched for ORPHAN_MS).
 * Blank drafts are discarded, never saved.
 */
export function sweepOrphanedDrafts(user, at = now()) {
  const committed = [];
  for (const row of q.draftsFor.all(user.id)) {
    if (!draftIsDue(row, at)) continue;
    const id = finalizeDraftRow(user, row);
    if (id) committed.push(id);
  }
  return committed;
}

/**
 * Process-wide sweep used by the background janitor. Returns every entry id
 * committed across all users in this pass.
 */
export function sweepDueDrafts(at = now()) {
  const committed = [];
  for (const row of q.dueDrafts.all(at, at - ORPHAN_MS)) {
    const user = { id: row.user_id };
    const id = finalizeDraftRow(user, row);
    if (id) committed.push(id);
  }
  return committed;
}

/** Re-assigns the device's draft when the active journal changes. */
export function reassignDraft(user, deviceId, journalId) {
  const journal = requireJournal(user, journalId);
  if (!deviceId) return null;
  const slot = q.draftFor.get(user.id, String(deviceId));
  if (!slot) return null;
  q.reassignDraft.run(journal.id, user.id, String(deviceId));
  return currentDraft(user, deviceId);
}

function normalizeContents(contents) {
  if (!Array.isArray(contents)) throw badRequest('contents must be an array');
  return contents.map((block) => {
    if (block?.kind === 'media') {
      const url = block.url ? normalizeMediaUrl(block.url) : null;
      const assetId = block.assetId ? String(block.assetId) : '';
      if (!url && !assetId) throw badRequest('media block needs an assetId or url');
      return {
        kind: 'media',
        assetId: url ? null : assetId,
        url,
        mediaType: block.mediaType === 'video' ? 'video' : 'photo',
        pixelWidth: Number(block.pixelWidth) || 0,
        pixelHeight: Number(block.pixelHeight) || 0,
        duration: block.duration == null ? null : Number(block.duration),
      };
    }
    return { kind: 'text', text: String(block?.text ?? '').trim() };
  });
}

const MEDIA_URL_MAX = 2048;

/** http(s) only — the client hotlinks these; the server never fetches them. */
export function normalizeMediaUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? ''));
  } catch {
    throw badRequest('Invalid media URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest('Media URL must be http(s)');
  }
  if (parsed.username || parsed.password) throw badRequest('Invalid media URL');
  if (parsed.href.length > MEDIA_URL_MAX) throw badRequest('Media URL is too long');
  return parsed.href;
}

/**
 * Empty (and near-empty) drafts are never saved. A draft qualifies only with a
 * media block or at least three non-whitespace characters of text.
 */
export const isBlank = (blocks) => {
  let nonWhitespace = 0;
  for (const block of blocks) {
    if (block.kind === 'media') return false;
    if (block.kind === 'text') {
      for (const char of block.text) {
        if (!/\s/.test(char)) {
          nonWhitespace += 1;
          if (nonWhitespace >= 3) return false;
        }
      }
    }
  }
  return true;
};

/**
 * Rewrites an entry's block list. Wrapped by its caller in a transaction so a
 * crash between the delete and the inserts cannot leave an entry emptied.
 */
function rewriteBlocks(entryId, blocks) {
  q.deleteBlocks.run(entryId);
  blocks.forEach((block, index) => {
    q.insertBlock.run(
      uuid(),
      entryId,
      index,
      block.kind,
      block.kind === 'text' ? block.text : null,
      block.kind === 'media' ? block.assetId : null,
      block.kind === 'media' ? (block.url ?? null) : null,
      block.kind === 'media' ? block.mediaType : null,
      block.kind === 'media' ? block.pixelWidth : null,
      block.kind === 'media' ? block.pixelHeight : null,
      block.kind === 'media' ? block.duration : null
    );
  });
}

// MARK: - Location

const GRANULARITIES = ['city', 'neighborhood', 'poi', 'exact'];

/** Validates an EntryLocation from a client, or null for untagged. */
export function normalizeLocation(location) {
  if (!location) return null;
  const granularity = String(location.granularity ?? '');
  if (!GRANULARITIES.includes(granularity)) throw badRequest('Unknown granularity');
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw badRequest('Location needs a coordinate');
  }
  return {
    granularity,
    displayName: location.displayName ? String(location.displayName) : null,
    latitude,
    longitude,
    isResolved: !!location.isResolved,
  };
}

/**
 * Finishes a pending geocode on an entry already in the journal. This
 * is the single exception to immutability, and a narrow one: the entry must
 * already be tagged, and only the resolution of that tag may land. An untagged
 * entry stays untagged, and nothing here can touch content.
 *
 * Tagging while writing needs none of this — the draft carries its location,
 * and the commit brings it along.
 */
export function resolveEntryLocation(user, entryId, location) {
  const entry = q.entryById.get(String(entryId ?? ''), user.id);
  if (!entry) throw notFound('No such entry');
  if (!entry.loc_granularity) throw badRequest('Committed entries are immutable');

  const resolved = normalizeLocation(location);
  if (!resolved) throw badRequest('Committed entries are immutable');

  q.setLocation.run(
    resolved.granularity,
    resolved.displayName,
    resolved.latitude,
    resolved.longitude,
    resolved.isResolved ? 1 : 0,
    entry.id
  );
  return entryWithBlocks({
    ...entry,
    loc_granularity: resolved.granularity,
    loc_display_name: resolved.displayName,
    loc_latitude: resolved.latitude,
    loc_longitude: resolved.longitude,
    loc_resolved: resolved.isResolved ? 1 : 0,
  });
}

/**
 * Wall-clock slug from the entry's own zone: YYYY-MM-DD-HH-MM. Collisions
 * append -2, -3, … Unique among all of this user's entries that already have a
 * slug, so republishing keeps a stable URL.
 */
export function wallClockSlug(createdAt, timeZoneId) {
  const zone = timeZoneId && String(timeZoneId).trim() ? String(timeZoneId) : 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(createdAt));
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(createdAt));
  }
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}`;
}

function allocatePublishSlug(userId, entry) {
  if (entry.publish_slug) return entry.publish_slug;
  const taken = new Set(q.takenSlugs.all(userId, entry.id).map((row) => row.slug));
  const base = wallClockSlug(entry.created_at, entry.time_zone_id);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw badRequest('Could not allocate a publish URL');
}

/**
 * The second exception to entry immutability: whether the entry appears on the
 * owner's public static site. Setting published assigns a stable slug the first
 * time; unpublishing keeps the slug so a later republish does not move the URL.
 */
export function setEntryPublished(user, entryId, published) {
  const entry = q.entryById.get(String(entryId ?? ''), user.id);
  if (!entry) throw notFound('No such entry');

  const next = !!published;
  if (!!entry.published === next) return entryWithBlocks(entry);

  const slug = next ? allocatePublishSlug(user.id, entry) : entry.publish_slug;
  q.setPublished.run(next ? 1 : 0, slug, entry.id, user.id);
  q.touchPublishChange.run(now());
  return entryWithBlocks({
    ...entry,
    published: next ? 1 : 0,
    publish_slug: slug,
  });
}

// MARK: - Read mode

/** The active journal's closed entries, newest first, with blocks attached. */
export function listEntries(user, journalId) {
  sweepOrphanedDrafts(user);
  const journal = requireJournal(user, journalId);
  const rows = q.committedEntries.all(user.id, journal.id);
  const byEntry = new Map(rows.map((row) => [row.id, []]));
  for (const block of q.blocksForUser.all(user.id, journal.id)) {
    byEntry.get(block.entry_id)?.push(block);
  }
  return rows.map((row) => serializeEntry(row, byEntry.get(row.id) ?? []));
}
