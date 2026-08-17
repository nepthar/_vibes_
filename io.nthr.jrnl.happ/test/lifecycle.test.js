import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The server's half of the entry lifecycle. The client owns the policy — when
 * an entry starts and when it is finished — and posts that as `finalizeIn` on
 * every scratch update. What is pinned here is that the server stores scratch
 * faithfully, converts finalize_in to an absolute deadline, commits when that
 * deadline (or a new entryId) arrives, keeps devices out of each other's way,
 * and never saves a blank draft.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'jrnl-test-'));
process.env.JRNL_DATA = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

let db;
let store;
let setUpAccount;
let createAccountToken;
let lookupAccountToken;
let login;
let userRow;
let journalId;

const text = (...values) => values.map((value) => ({ kind: 'text', text: value }));
const media = (assetId) => ({
  kind: 'media',
  assetId,
  mediaType: 'photo',
  pixelWidth: 4,
  pixelHeight: 3,
});

const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id);
const uuid = () => crypto.randomUUID();

async function freshUser(name) {
  const { token } = createAccountToken(name);
  const result = await setUpAccount({ accountToken: token, password: 'notebook123' });
  userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result.user.id);
  journalId = result.user.activeJournalId;
}

/** Writing in progress on a device, as the client would post it. */
const draft = (deviceId, entryId, contents, clientTime, extra = {}) =>
  store.updateDraft(user(), {
    deviceId,
    entryId,
    journalId,
    contents,
    clientTime,
    startedAt: clientTime,
    timeZone: 'America/Los_Angeles',
    finalizeIn: 300,
    ...extra,
  });

before(async () => {
  ({ db } = await import('../server/db.js'));
  store = await import('../server/entries.js');
  ({ setUpAccount, createAccountToken, lookupAccountToken, login } = await import(
    '../server/auth.js'
  ));
});

describe('scratch space', () => {
  before(() => freshUser('scratch'));

  test('holds writing in progress for a device', () => {
    const entryId = uuid();
    const before = Date.now();
    const result = draft('device-a', entryId, text('Half a thought'), 1000);
    assert.equal(result.accepted, true);

    const held = store.currentDraft(user(), 'device-a');
    assert.equal(held.entryId, entryId);
    assert.deepEqual(held.blocks, text('Half a thought'));
    assert.equal(held.timeZoneId, 'America/Los_Angeles');
    assert.ok(held.finalizeAt >= before + 300_000);
    assert.ok(held.finalizeAt <= Date.now() + 300_000);
  });

  test('each update slides the finalize deadline forward', () => {
    const entryId = uuid();
    draft('device-slide', entryId, text('first pass'), 1000, { finalizeIn: 60 });
    const first = store.currentDraft(user(), 'device-slide').finalizeAt;
    draft('device-slide', entryId, text('second pass'), 2000, { finalizeIn: 60 });
    const second = store.currentDraft(user(), 'device-slide').finalizeAt;
    assert.ok(second >= first);
  });

  test('a new entryId finalizes the previous draft in the slot', () => {
    const older = uuid();
    const newer = uuid();
    draft('device-roll', older, text('finished by rollover'), 10_000);
    draft('device-roll', newer, text('already moved on'), 11_000);

    assert.equal(store.currentDraft(user(), 'device-roll').entryId, newer);
    const committed = store.listEntries(user(), journalId).find((e) => e.id === older);
    assert.equal(committed.blocks[0].text, 'finished by rollover');
    assert.equal(committed.createdAt, 10_000);
  });

  test('a new entryId discards a blank previous draft', () => {
    const older = uuid();
    const newer = uuid();
    draft('device-blank-roll', older, text('ab'), 12_000);
    draft('device-blank-roll', newer, text('real entry here'), 13_000);

    assert.equal(store.currentDraft(user(), 'device-blank-roll').entryId, newer);
    assert.equal(
      store.listEntries(user(), journalId).filter((e) => e.id === older).length,
      0
    );
  });

  test('two devices never contend — each has its own slot', () => {
    const [a, b] = [uuid(), uuid()];
    draft('device-a', a, text('written on the laptop'), 2000);
    draft('device-b', b, text('written on the phone'), 2001);

    assert.deepEqual(store.currentDraft(user(), 'device-a').blocks, text('written on the laptop'));
    assert.deepEqual(store.currentDraft(user(), 'device-b').blocks, text('written on the phone'));
  });

  test('a stale writer cannot clobber a live one', () => {
    const entryId = uuid();
    draft('device-c', entryId, text('the current text'), 5000);

    // A second tab on the same device, behind on the clock.
    const stale = draft('device-c', entryId, text('an older version'), 4000);
    assert.equal(stale.accepted, false);
    assert.deepEqual(store.currentDraft(user(), 'device-c').blocks, text('the current text'));

    // Moving forward again is accepted.
    assert.equal(draft('device-c', entryId, text('the newest text'), 6000).accepted, true);
  });

  test('a device with no slot simply has none', () => {
    assert.equal(store.currentDraft(user(), 'device-unknown'), null);
    assert.equal(store.currentDraft(user(), null), null);
  });

  test('discarding clears the slot', () => {
    draft('device-d', uuid(), text('never mind'), 7000);
    store.discardDraft(user(), 'device-d');
    assert.equal(store.currentDraft(user(), 'device-d'), null);
  });
});

describe('committing', () => {
  before(() => freshUser('committing'));

  test('the client chooses the id and sends the whole entry', () => {
    const id = uuid();
    const { entry, created } = store.commitEntry(user(), {
      id,
      journalId,
      contents: text('A finished thought.'),
      createdAt: 1_700_000_000_000,
      timeZone: 'America/Los_Angeles',
      location: {
        granularity: 'neighborhood',
        displayName: 'Temescal, Oakland',
        latitude: 37.836,
        longitude: -122.2626,
        isResolved: true,
      },
    });

    assert.equal(created, true);
    assert.equal(entry.id, id);
    assert.equal(entry.createdAt, 1_700_000_000_000, "the client's clock is authoritative");
    assert.equal(entry.location.displayName, 'Temescal, Oakland');
    assert.deepEqual(entry.blocks, text('A finished thought.'));
  });

  test('a retry after a lost response changes nothing', () => {
    const id = uuid();
    const payload = { id, journalId, contents: text('Sent twice.'), createdAt: 1_700_000_001_000 };

    const first = store.commitEntry(user(), payload);
    const second = store.commitEntry(user(), payload);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.entry.id, id);
    assert.equal(store.listEntries(user(), journalId).filter((e) => e.id === id).length, 1);
  });

  test('committing clears that device slot, and only if it still holds the entry', () => {
    const mine = uuid();
    draft('device-x', mine, text('about to commit'), 9000);
    draft('device-y', uuid(), text('someone else is writing'), 9001);

    store.commitEntry(user(), {
      id: mine,
      journalId,
      contents: text('about to commit'),
      createdAt: 9000,
      deviceId: 'device-x',
    });

    assert.equal(store.currentDraft(user(), 'device-x'), null);
    assert.ok(store.currentDraft(user(), 'device-y'), 'another device is untouched');
  });

  test('a slot holding a newer entry survives a late commit of an older one', () => {
    const older = uuid();
    draft('device-z', older, text('first thought'), 10_000);
    const newer = uuid();
    draft('device-z', newer, text('already moved on'), 11_000);

    // The new entryId already finalized the older draft; a late client commit
    // is a no-op and must not clear the slot that now holds the newer one.
    const { created } = store.commitEntry(user(), {
      id: older,
      journalId,
      contents: text('first thought'),
      createdAt: 10_000,
      deviceId: 'device-z',
    });

    assert.equal(created, false);
    assert.equal(store.currentDraft(user(), 'device-z').entryId, newer);
  });

  test('an empty entry is never saved', () => {
    assert.throws(
      () => store.commitEntry(user(), { id: uuid(), journalId, contents: text('   ') }),
      /empty/
    );
    assert.throws(
      () => store.commitEntry(user(), { id: uuid(), journalId, contents: text('ab') }),
      /empty/
    );
  });

  test('text is trimmed and three non-whitespace characters qualify', () => {
    const id = uuid();
    const { entry } = store.commitEntry(user(), {
      id,
      journalId,
      contents: text('  abc  '),
      createdAt: 14_000,
    });
    assert.deepEqual(entry.blocks, text('abc'));
  });

  test('media blocks survive the commit', () => {
    const id = uuid();
    const { entry } = store.commitEntry(user(), {
      id,
      journalId,
      contents: [...text('A photo:'), media('asset-1'), ...text('and after.')],
      createdAt: 12_000,
    });
    assert.equal(entry.blocks.length, 3);
    assert.equal(entry.blocks[1].assetId, 'asset-1');
  });

  test('a linked photo is stored as a URL, not an upload', () => {
    const id = uuid();
    const { entry } = store.commitEntry(user(), {
      id,
      journalId,
      contents: [
        {
          kind: 'media',
          url: 'https://cdn.example.com/day.jpg',
          mediaType: 'photo',
          pixelWidth: 800,
          pixelHeight: 600,
        },
      ],
      createdAt: 13_000,
    });
    assert.equal(entry.blocks[0].url, 'https://cdn.example.com/day.jpg');
    assert.equal(entry.blocks[0].assetId, undefined);
  });

  test('javascript: media URLs are refused', () => {
    assert.throws(
      () =>
        store.commitEntry(user(), {
          id: uuid(),
          journalId,
          contents: [{ kind: 'media', url: 'javascript:alert(1)', mediaType: 'photo' }],
        }),
      /http/
    );
  });
});

describe('the janitor', () => {
  before(() => freshUser('janitor'));

  test('leaves a live slot alone', () => {
    draft('device-live', uuid(), text('still being written'), Date.now());
    assert.deepEqual(store.sweepOrphanedDrafts(user()), []);
    assert.ok(store.currentDraft(user(), 'device-live'));
  });

  test('commits a draft whose finalize_at has passed', () => {
    const entryId = uuid();
    draft('device-gone', entryId, text('written, then the tab closed'), 50_000);
    db.prepare('UPDATE drafts SET finalize_at = ? WHERE device_id = ?').run(
      Date.now() - 1000,
      'device-gone'
    );

    const swept = store.sweepOrphanedDrafts(user());
    assert.deepEqual(swept, [entryId]);
    assert.equal(store.currentDraft(user(), 'device-gone'), null);

    const committed = store.listEntries(user(), journalId).find((e) => e.id === entryId);
    assert.equal(committed.blocks[0].text, 'written, then the tab closed');
    assert.equal(committed.createdAt, 50_000, 'keeps the time it was actually written');
  });

  test('discards a due slot that was empty', () => {
    draft('device-blank', uuid(), text('ab'), 60_000);
    db.prepare('UPDATE drafts SET finalize_at = ? WHERE device_id = ?').run(
      Date.now() - 1000,
      'device-blank'
    );
    assert.deepEqual(store.sweepOrphanedDrafts(user()), []);
    assert.equal(store.currentDraft(user(), 'device-blank'), null);
  });

  test('the device coming back later does not double-commit', () => {
    const entryId = uuid();
    draft('device-slow', entryId, text('swept while away'), 70_000);
    db.prepare('UPDATE drafts SET finalize_at = ? WHERE device_id = ?').run(
      Date.now() - 1000,
      'device-slow'
    );
    store.sweepOrphanedDrafts(user());

    // It reconnects and commits what it was holding, as if nothing happened.
    const { created } = store.commitEntry(user(), {
      id: entryId,
      journalId,
      contents: text('swept while away'),
      createdAt: 70_000,
    });
    assert.equal(created, false);
    assert.equal(store.listEntries(user(), journalId).filter((e) => e.id === entryId).length, 1);
  });

  test('legacy rows without finalize_at still fall back to the orphan window', () => {
    const entryId = uuid();
    draft('device-legacy', entryId, text('old shape of row'), 80_000);
    db.prepare(
      'UPDATE drafts SET finalize_at = NULL, received_at = ? WHERE device_id = ?'
    ).run(Date.now() - store.ORPHAN_MS - 1000, 'device-legacy');

    assert.deepEqual(store.sweepOrphanedDrafts(user()), [entryId]);
    assert.equal(store.currentDraft(user(), 'device-legacy'), null);
  });
});

describe('journals', () => {
  before(() => freshUser('journals'));

  test('a new user starts with the default personal journal', () => {
    const journals = store.listJournals(user());
    assert.equal(journals.length, 1);
    assert.equal(journals[0].name, 'personal');
  });

  test('journal names are unique case-insensitively', () => {
    const created = store.createJournal(user(), 'Work');
    const again = store.createJournal(user(), 'work');
    assert.equal(created.id, again.id);
    assert.equal(store.listJournals(user()).length, 2);
  });

  test('switching journals mid-entry moves the draft with the choice', () => {
    const work = store.createJournal(user(), 'work');
    draft('device-a', uuid(), text('started in personal'), 1000);

    const moved = store.reassignDraft(user(), 'device-a', work.id);
    assert.equal(moved.journalId, work.id);
  });
});

describe('location', () => {
  before(() => freshUser('location'));

  test('a draft carries its location, and the commit brings it along', () => {
    const entryId = uuid();
    draft('device-a', entryId, text('here'), 1000, {
      location: {
        granularity: 'neighborhood',
        displayName: 'Temescal, Oakland',
        latitude: 37.836,
        longitude: -122.2626,
        isResolved: true,
      },
    });
    const held = store.currentDraft(user(), 'device-a');
    assert.equal(held.location.displayName, 'Temescal, Oakland');

    const { entry } = store.commitEntry(user(), {
      id: entryId,
      journalId,
      contents: text('here'),
      createdAt: 1000,
      location: held.location,
      deviceId: 'device-a',
    });
    assert.equal(entry.location.displayName, 'Temescal, Oakland');
    assert.equal(entry.location.latitude, 37.836);
  });

  test('a pending geocode may still finish after the commit', () => {
    const entryId = uuid();
    store.commitEntry(user(), {
      id: entryId,
      journalId,
      contents: text('tagged but unresolved'),
      createdAt: 2000,
      // The captured point, before the name and centroid came back.
      location: { granularity: 'city', latitude: 37.8355, longitude: -122.2622, isResolved: false },
    });

    const resolved = store.resolveEntryLocation(user(), entryId, {
      granularity: 'city',
      displayName: 'Oakland, CA',
      latitude: 37.8044,
      longitude: -122.2712,
      isResolved: true,
    });
    assert.equal(resolved.location.displayName, 'Oakland, CA');
    assert.equal(resolved.location.latitude, 37.8044, 'the centroid replaced the captured point');
  });

  test('an untagged committed entry stays immutable', () => {
    const entryId = uuid();
    store.commitEntry(user(), {
      id: entryId,
      journalId,
      contents: text('no location'),
      createdAt: 3000,
    });
    assert.throws(
      () =>
        store.resolveEntryLocation(user(), entryId, {
          granularity: 'city',
          latitude: 1,
          longitude: 2,
          isResolved: true,
        }),
      /immutable/
    );
  });
});

describe('account tokens', () => {
  const sessionCount = (userId) =>
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;

  test('setup without a token is refused', async () => {
    await assert.rejects(() => setUpAccount({ password: 'notebook123' }), /account token/i);
  });

  test('the name is the operator’s choice, checked when the token is minted', () => {
    assert.throws(() => createAccountToken('no spaces here'), /Username can use/i);
    assert.throws(() => createAccountToken('x'), /2–32 characters/i);
  });

  test('a token names the account it will create', async () => {
    const { token } = createAccountToken('invited');
    const pending = lookupAccountToken(token);
    assert.equal(pending.username, 'invited');
    assert.equal(pending.exists, false);

    const result = await setUpAccount({ accountToken: token, password: 'notebook123' });
    assert.equal(result.user.username, 'invited');
    assert.equal(result.created, true);
    // A new account arrives with its default journal, active.
    assert.ok(result.user.activeJournalId);
  });

  test('a token works once and then is gone', async () => {
    const { token } = createAccountToken('once');
    await setUpAccount({ accountToken: token, password: 'notebook123' });
    assert.throws(() => lookupAccountToken(token), /account token/i);
    await assert.rejects(
      () => setUpAccount({ accountToken: token, password: 'notebook123' }),
      /account token/i
    );
  });

  test('an expired token is refused and not consumed', async () => {
    const { token } = createAccountToken('late');
    db.prepare('UPDATE account_tokens SET expires_at = 1 WHERE token = ?').run(token);
    await assert.rejects(
      () => setUpAccount({ accountToken: token, password: 'notebook123' }),
      /account token/i
    );
    assert.ok(db.prepare('SELECT token FROM account_tokens WHERE token = ?').get(token));
  });

  test('a token for an existing name resets that account', async () => {
    const created = await setUpAccount({
      accountToken: createAccountToken('returning').token,
      password: 'notebook123',
    });
    const userId = created.user.id;
    assert.equal(sessionCount(userId), 1);

    const reset = createAccountToken('returning');
    assert.equal(reset.exists, true);
    assert.equal(lookupAccountToken(reset.token).exists, true);

    const after = await setUpAccount({ accountToken: reset.token, password: 'newnotebook456' });
    // Same account — the journal and everything keyed to the user survive.
    assert.equal(after.user.id, userId);
    assert.equal(after.created, false);
    assert.equal(after.user.activeJournalId, created.user.activeJournalId);
    // The old password is dead, and so is every session signed in under it.
    await assert.rejects(
      () => login({ username: 'returning', password: 'notebook123' }),
      /Invalid username or password/
    );
    assert.equal(sessionCount(userId), 1);
    const back = await login({ username: 'returning', password: 'newnotebook456' });
    assert.equal(back.user.id, userId);
  });

  test('minting again for a name retires the outstanding token', async () => {
    const first = createAccountToken('superseded');
    const second = createAccountToken('superseded');
    assert.throws(() => lookupAccountToken(first.token), /account token/i);
    assert.equal(lookupAccountToken(second.token).username, 'superseded');
  });
});
