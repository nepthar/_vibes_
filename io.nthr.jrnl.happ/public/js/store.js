/**
 * The local copy of the journal.
 *
 * Read mode renders from here, so opening the app — and switching to the
 * calendar or the map — never waits on the network. The server is refreshed
 * from in the background and remains the source of truth: browsers evict
 * IndexedDB under storage pressure, and Safari clears script-writable storage
 * for sites left unvisited for about a week, so nothing here may be treated as
 * durable. This is a cache and a write buffer, not the record.
 *
 * Committed entries are immutable and never deleted, which is what makes this
 * tractable: reconciling local and remote is a set union, never a negotiation.
 */

const DB_VERSION = 1;
const dbName = (userId) => `jrnl:${userId}`;

const promisify = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class LocalStore {
  constructor(db, userId) {
    this.db = db;
    this.userId = userId;
  }

  /**
   * Opens this user's store. Returns null when IndexedDB is unavailable or
   * refuses to open (private windows, exhausted quota) — every caller treats a
   * missing store as "no cache", so the app simply falls back to the network.
   */
  static async open(userId) {
    if (!globalThis.indexedDB) return null;
    try {
      const request = indexedDB.open(dbName(userId), DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('entries')) {
          const entries = db.createObjectStore('entries', { keyPath: 'id' });
          entries.createIndex('journalId', 'journalId');
        }
      };
      return new LocalStore(await promisify(request), userId);
    } catch {
      return null;
    }
  }

  /** Wipes the local copy — on sign-out, so one account never sees another's. */
  static async destroy(userId) {
    if (!globalThis.indexedDB) return;
    try {
      await promisify(indexedDB.deleteDatabase(dbName(userId)));
    } catch {
      // Nothing to do: a store we cannot delete is one we also cannot read.
    }
  }

  transaction(mode) {
    return this.db.transaction('entries', mode).objectStore('entries');
  }

  /** One journal's entries, newest first — the order read mode wants. */
  async entriesFor(journalId) {
    try {
      const index = this.transaction('readonly').index('journalId');
      const rows = await promisify(index.getAll(journalId));
      return rows.sort((a, b) => b.createdAt - a.createdAt).map(stripLocalFields);
    } catch {
      return [];
    }
  }

  async put(entry, { synced = true } = {}) {
    try {
      await promisify(this.transaction('readwrite').put({ ...entry, synced }));
    } catch {
      // A cache that cannot be written is a cache miss, not an error.
    }
  }

  /**
   * Folds a server response into the cache. Entries committed locally but not
   * yet acknowledged are left alone — they are the write buffer, and the
   * server simply hasn't heard about them yet.
   */
  async merge(entries) {
    try {
      const store = this.transaction('readwrite');
      await Promise.all(entries.map((entry) => promisify(store.put({ ...entry, synced: true }))));
    } catch {
      // Ignored for the same reason as `put`.
    }
  }

  /** Entries the server has not confirmed, oldest first, for retrying. */
  async unsynced() {
    try {
      const rows = await promisify(this.transaction('readonly').getAll());
      return rows
        .filter((row) => row.synced === false)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(stripLocalFields);
    } catch {
      return [];
    }
  }

  async markSynced(id) {
    try {
      const store = this.transaction('readwrite');
      const row = await promisify(store.get(id));
      if (row) await promisify(store.put({ ...row, synced: true }));
    } catch {
      // See above.
    }
  }
}

/** `synced` is bookkeeping for this cache and never leaves it. */
function stripLocalFields({ synced, ...entry }) {
  return entry;
}
