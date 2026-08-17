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
let signup;
let createSignupToken;
let userRow;
let journalId;

const text = (...values) => values.map((value) => ({ kind: 'text', text: value }));
const uuid = () => crypto.randomUUID();

async function freshUser(name) {
  const { token } = createSignupToken();
  const result = await signup({ username: name, password: 'notebook123', signupToken: token });
  userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result.user.id);
  journalId = result.user.activeJournalId;
}

before(async () => {
  ({ db } = await import('../server/db.js'));
  store = await import('../server/entries.js');
  publish = await import('../server/publish.js');
  ({ signup, createSignupToken } = await import('../server/auth.js'));
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
    assert.match(html, /href="\/p\/alice\/styles\.css"/);
    assert.match(html, /href="\/p\/alice\/2024-07-14-18-00"/);
    assert.doesNotMatch(html, /<script/i);

    const article = join(dataDir, 'published', 'alice', '2024-07-14-18-00.html');
    assert.equal(existsSync(article), true);
    assert.match(readFileSync(article, 'utf8'), /First/);
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
