import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'jrnl-publish-'));
process.env.JRNL_DATA = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

let db;
let store;
let publish;
let setUpAccount;
let createAccountToken;
let userRow;
let journalId;

const text = (...values) => values.map((value) => ({ kind: 'text', text: value }));
const uuid = () => crypto.randomUUID();

async function freshUser(name) {
  const { token } = createAccountToken(name);
  const result = await setUpAccount({ accountToken: token, password: 'notebook123' });
  userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result.user.id);
  journalId = result.user.activeJournalId;
}

before(async () => {
  ({ db } = await import('../server/db.js'));
  store = await import('../server/entries.js');
  publish = await import('../server/publish.js');
  ({ setUpAccount, createAccountToken } = await import('../server/auth.js'));
  await freshUser('alice');
});

describe('publishing', () => {
  test('slug uses the entry time zone, not UTC', () => {
    // 2024-01-15 08:30 America/Denver = 15:30 UTC
    const createdAt = Date.parse('2024-01-15T15:30:00.000Z');
    assert.equal(store.wallClockSlug(createdAt, 'America/Denver'), '2024-01-15-08-30');
    assert.equal(store.wallClockSlug(createdAt, 'UTC'), '2024-01-15-15-30');
  });

  test('collision appends -2', async () => {
    const t = Date.parse('2024-07-14T18:00:00.000Z');
    const a = store.commitEntry(userRow, {
      id: uuid(),
      journalId,
      contents: text('First'),
      createdAt: t,
      lastInteractionAt: t,
      timeZone: 'UTC',
    }).entry;
    const b = store.commitEntry(userRow, {
      id: uuid(),
      journalId,
      contents: text('Second'),
      createdAt: t + 1,
      lastInteractionAt: t + 1,
      timeZone: 'UTC',
    }).entry;

    const pubA = store.setEntryPublished(userRow, a.id, true);
    const pubB = store.setEntryPublished(userRow, b.id, true);
    assert.equal(pubA.publishSlug, '2024-07-14-18-00');
    assert.equal(pubB.publishSlug, '2024-07-14-18-00-2');
  });

  test('rebuild writes static list and article pages', async () => {
    assert.equal(publish.publishIsDirty(), true);
    const result = await publish.runPublishJob();
    assert.equal(result.ok, true);
    assert.equal(publish.publishIsDirty(), false);

    const index = join(dataDir, 'published', 'alice', 'index.html');
    assert.equal(existsSync(index), true);
    const html = readFileSync(index, 'utf8');
    assert.match(html, /noindex/);
    assert.match(html, /alice/);
    // The stylesheet is named for its own hash, since it is served immutable.
    const theme = /href="\/p\/alice\/(styles\.[0-9a-f]{8}\.css)"/.exec(html);
    assert.ok(theme, 'index links a content-hashed stylesheet');
    assert.equal(existsSync(join(dataDir, 'published', 'alice', theme[1])), true);
    assert.equal(existsSync(join(dataDir, 'published', 'alice', 'styles.css')), false);
    assert.match(html, /href="\/p\/alice\/2024-07-14-18-00"/);
    assert.doesNotMatch(html, /<script/i);

    const article = join(dataDir, 'published', 'alice', '2024-07-14-18-00.html');
    assert.equal(existsSync(article), true);
    assert.match(readFileSync(article, 'utf8'), /First/);
  });

  test('the list reads like the private one: day headers, time · place, first line', async () => {
    const at = Date.now();
    const today = store.commitEntry(userRow, {
      id: uuid(),
      journalId,
      contents: text('Today’s line, the one the list shows.\nA second line it must not show.'),
      createdAt: at,
      lastInteractionAt: at,
      timeZone: 'UTC',
      location: {
        granularity: 'city',
        displayName: 'Oakland, CA',
        latitude: 37.8,
        longitude: -122.27,
        isResolved: true,
      },
    }).entry;
    store.setEntryPublished(userRow, today.id, true);
    assert.equal((await publish.runPublishJob()).ok, true);

    const html = readFileSync(join(dataDir, 'published', 'alice', 'index.html'), 'utf8');
    // Day headers are dates, never "Today" — the page outlives the day it was
    // written, and nothing rewrites it when tomorrow comes.
    assert.match(html, /<h2 class="day-header">July 14, 2024<\/h2>/);
    assert.match(html, /<h2 class="day-header">[A-Z][a-z]+ \d{1,2}, \d{4}<\/h2>/);
    assert.doesNotMatch(html, /day-header">(Today|Yesterday)</);
    assert.match(html, /<span class="entry-time">[\d:]+ [AP]M<\/span>/);
    assert.match(html, /<span class="entry-place">Oakland, CA<\/span>/);
    assert.match(html, /<p class="entry-text">Today’s line, the one the list shows\.<\/p>/);
    assert.doesNotMatch(html, /second line it must not show/);
    // Still a link per entry, and still no JavaScript.
    assert.match(html, /<a class="entry-row" href="\/p\/alice\/2024-07-14-18-00">/);
    assert.doesNotMatch(html, /<script/i);
  });

  test('unpublishing last entries deletes the tree', async () => {
    for (const entry of store.listEntries(userRow, journalId)) {
      if (entry.published) store.setEntryPublished(userRow, entry.id, false);
    }
    const result = await publish.runPublishJob();
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(dataDir, 'published', 'alice')), false);
  });

  test('republish keeps the original slug', () => {
    const entries = store.listEntries(userRow, journalId);
    const first = entries.find((entry) => entry.publishSlug === '2024-07-14-18-00');
    assert.ok(first);
    const again = store.setEntryPublished(userRow, first.id, true);
    assert.equal(again.publishSlug, '2024-07-14-18-00');
  });
});
