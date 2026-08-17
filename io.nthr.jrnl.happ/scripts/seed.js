/**
 * Dev-only history seeding — the web counterpart of the iOS app's
 * `--seed-history` launch flag. Populates closed entries across several days,
 * places, and journals so read mode's list, calendar, and map can be checked
 * without waiting out the finish window.
 *
 *   node scripts/seed.js <username> [--reset]
 */

import { db, uuid } from '../server/db.js';

const [username, ...flags] = process.argv.slice(2);
if (!username) {
  console.error('usage: node scripts/seed.js <username> [--reset]');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!user) {
  console.error(`No such user: ${username}`);
  process.exit(1);
}

const listJournals = db.prepare('SELECT * FROM journals WHERE user_id = ? ORDER BY created_at');
const insertJournal = db.prepare(
  'INSERT INTO journals (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
);
const insertEntry = db.prepare(
  `INSERT INTO entries
     (id, user_id, journal_id, created_at, time_zone_id, last_interaction_at, received_at,
      loc_granularity, loc_display_name, loc_latitude, loc_longitude, loc_resolved)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertBlock = db.prepare(
  `INSERT INTO blocks
     (id, entry_id, idx, kind, text, asset_id, url, media_type, pixel_width, pixel_height, duration)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const deleteEntries = db.prepare('DELETE FROM entries WHERE user_id = ?');
const deleteDrafts = db.prepare('DELETE FROM drafts WHERE user_id = ?');

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = Date.now();

function ensureJournal(name) {
  const existing = listJournals
    .all(user.id)
    .find((journal) => journal.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const journal = { id: uuid(), user_id: user.id, name, created_at: now };
  insertJournal.run(journal.id, user.id, name, journal.created_at);
  return journal;
}

const personal = ensureJournal('personal');
const work = ensureJournal('work');
const travel = ensureJournal('travel');

if (flags.includes('--reset')) {
  deleteEntries.run(user.id);
  deleteDrafts.run(user.id);
  console.log('cleared existing entries and drafts');
}

/**
 * daysAgo, hour, minute, journal, place, lat, lon, granularity, blocks[]
 * blocks are either a string (text) or { kind: 'media', ... }.
 */
const SAMPLES = [
  // Today — enough for a busy heatmap cell and day grouping
  [0, 7, 12, personal, 'Temescal, Oakland', 37.836, -122.2626, 'neighborhood', [
    'Morning pages before the day gets loud. The coffee shop window seat again.',
  ]],
  [0, 9, 40, work, null, null, null, null, [
    'Standup notes: ship the draft finalize path, leave the orphan window as a legacy backstop.',
  ]],
  [0, 12, 5, personal, 'Arbor Cafe, Oakland', 37.8351, -122.2631, 'poi', [
    'Lunch alone on purpose. It is the only quiet hour I get.',
  ]],
  [0, 15, 22, work, 'Oakland, CA', 37.8044, -122.2712, 'city', [
    'Halfway through the afternoon and the idea finally clicked into place.',
    {
      kind: 'media',
      url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800',
      mediaType: 'photo',
      pixelWidth: 800,
      pixelHeight: 534,
    },
    'Kept the sketch above — better than another paragraph of explaining.',
  ]],
  [0, 21, 8, personal, 'Oakland, CA', 37.8044, -122.2712, 'city', [
    'Reread what I wrote this morning. Kept two sentences, cut the rest.',
  ]],

  // Yesterday
  [1, 8, 0, personal, 'Temescal, Oakland', 37.836, -122.2626, 'neighborhood', [
    'Rain all night. The street smells like wet pavement and eucalyptus.',
  ]],
  [1, 13, 30, work, null, null, null, null, [
    'Review notes. The three-character blank rule feels right — "hi" should never become an entry.',
  ]],
  [1, 20, 15, personal, 'Jack London Square, Oakland', 37.7949, -122.2776, 'neighborhood', [
    'Long walk by the water. Wrote this on a bench watching the ferries.',
  ]],

  // Two days ago — stacked for intensity
  [2, 8, 10, personal, 'Temescal, Oakland', 37.836, -122.2626, 'neighborhood', [
    'Quick thought: the best part of journaling is rereading, not writing.',
  ]],
  [2, 11, 45, personal, 'Arbor Cafe, Oakland', 37.8351, -122.2631, 'poi', ['Short one.']],
  [2, 14, 0, work, 'Oakland, CA', 37.8044, -122.2712, 'city', [
    'Three entries today, which either means a good day or a restless one.',
  ]],
  [2, 19, 20, personal, 'Temescal, Oakland', 37.836, -122.2626, 'neighborhood', [
    'Evening wrap. Put the phone face-down and finished the thought here instead.',
  ]],
  [2, 22, 55, personal, null, null, null, null, [
    'Late note — almost blank territory, but long enough to keep.',
  ]],

  // SF cluster for the map
  [6, 17, 5, travel, 'Mission, San Francisco', 37.7599, -122.4148, 'neighborhood', [
    'Crossed the bridge at golden hour. The whole bay went copper.',
    {
      kind: 'media',
      url: 'https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=800',
      mediaType: 'photo',
      pixelWidth: 800,
      pixelHeight: 533,
    },
  ]],
  [7, 11, 20, travel, 'Mission, San Francisco', 37.7599, -122.4148, 'neighborhood', [
    'Bookstore on Valencia. Left with two more than I meant to buy.',
  ]],
  [7, 15, 40, travel, 'Golden Gate Park, San Francisco', 37.7694, -122.4862, 'neighborhood', [
    'Sat under a tree and wrote until the battery complained.',
  ]],
  [8, 19, 0, travel, 'North Beach, San Francisco', 37.8006, -122.4102, 'neighborhood', [
    'Dinner alone with a notebook. The waiter asked if I was a writer. Said yes to be polite.',
  ]],

  // Farther back for calendar depth
  [12, 22, 10, personal, 'Oakland, CA', 37.8044, -122.2712, 'city', [
    'End of a strange week. Putting it down here so I can let it go.',
  ]],
  [14, 9, 0, work, null, null, null, null, [
    'Kickoff notes from two weeks ago. Useful only as proof that plans change.',
  ]],
  [21, 7, 30, personal, 'Temescal, Oakland', 37.836, -122.2626, 'neighborhood', [
    'Woke before the alarm. Wrote a page just to prove the habit still holds.',
  ]],
  [21, 18, 45, personal, 'Lake Merritt, Oakland', 37.8015, -122.2583, 'neighborhood', [
    'Circled the lake twice. Second lap was where the sentence arrived.',
  ]],
  [30, 12, 0, travel, 'Portland, OR', 45.5152, -122.6784, 'city', [
    'Rain again, different city. Same habit of writing in cafes.',
  ]],
  [30, 16, 20, travel, 'Powell\'s City of Books, Portland', 45.5231, -122.6816, 'poi', [
    'Lost an hour in the literature room and did not regret it.',
  ]],
  [40, 16, 0, personal, 'Oakland, CA', 37.8044, -122.2712, 'city', [
    'Old entry, kept for the calendar to have something further back to shade.',
  ]],
  [45, 10, 15, work, null, null, null, null, [
    'A very long entry for scroll testing. '.repeat(12).trim(),
  ]],
  [60, 8, 0, personal, 'Berkeley, CA', 37.8715, -122.273, 'city', [
    'Two months back. The map should still find this one.',
  ]],
];

let count = 0;
for (const [daysAgo, hour, minute, journal, place, latitude, longitude, granularity, blocks] of SAMPLES) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  const created = date.getTime();
  const lastInteraction = created + 4 * 60 * 1000;

  const id = uuid();
  insertEntry.run(
    id,
    user.id,
    journal.id,
    created,
    zone,
    lastInteraction,
    created,
    granularity,
    place,
    latitude,
    longitude,
    place ? 1 : 0
  );

  blocks.forEach((block, index) => {
    if (typeof block === 'string') {
      insertBlock.run(uuid(), id, index, 'text', block, null, null, null, null, null, null);
      return;
    }
    insertBlock.run(
      uuid(),
      id,
      index,
      'media',
      null,
      null,
      block.url,
      block.mediaType,
      block.pixelWidth,
      block.pixelHeight,
      block.duration ?? null
    );
  });
  count += 1;
}

console.log(
  `seeded ${count} entries across ${[personal, work, travel].map((j) => j.name).join(', ')} for ${user.username}`
);
