import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { db, mediaDir, now, publishedDir } from './db.js';

/**
 * Static public sites for published entries.
 *
 * One process-wide job runs every PUBLISH_MS (and on startup when dirty). It
 * rebuilds `/p/<username>/` from scratch for every user who has at least one
 * published entry, and deletes the tree when they have none. Generated HTML
 * has no JavaScript; owned media is copied into the tree; remote media URLs
 * stay hotlinked.
 */

export const PUBLISH_MS = Number(process.env.JRNL_PUBLISH_MS) || 5 * 60 * 1000;

const q = {
  meta: db.prepare('SELECT change_at, last_success_at FROM publish_meta WHERE id = 1'),
  markSuccess: db.prepare('UPDATE publish_meta SET last_success_at = ? WHERE id = 1'),
  users: db.prepare('SELECT id, username FROM users'),
  publishedEntries: db.prepare(
    `SELECT * FROM entries
     WHERE user_id = ? AND published = 1
     ORDER BY created_at DESC, id DESC`
  ),
  blocksFor: db.prepare('SELECT * FROM blocks WHERE entry_id = ? ORDER BY idx'),
  mediaById: db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?'),
};

const MIME_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['image/avif', 'avif'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
]);

export function publishIsDirty() {
  const row = q.meta.get();
  if (!row) return false;
  return row.change_at > row.last_success_at;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = escapeHtml;

const ORDINALS = new Intl.PluralRules('en', { type: 'ordinal' });
const SUFFIXES = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
const ordinal = (number) => `${number}${SUFFIXES[ORDINALS.select(number)] ?? 'th'}`;

/** Every rendered date is in the entry's own zone: the wall clock the writer saw. */
const zoneOf = (timeZoneId) =>
  timeZoneId && String(timeZoneId).trim() ? String(timeZoneId) : 'UTC';

function zoneFormat(zone, options) {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone, ...options });
  } catch {
    return new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...options });
  }
}

/** `YYYY-MM-DD` in `zone`, the key entries are grouped by. */
function dayKey(ms, zone) {
  const parts = zoneFormat(zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The day header, always the full date. The private list says "Today" and
 * "Yesterday" because it is rendered in front of a reader; a page written
 * once and read for years cannot say when now is.
 */
const dayHeading = (ms, zone) =>
  zoneFormat(zone, { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));

const timeLabel = (ms, zone) =>
  zoneFormat(zone, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

/** Title line in the entry's own zone — matches the private app stamp. */
function entryTitle(createdAt, timeZoneId, place) {
  const zone = zoneOf(timeZoneId);
  const format = (options) => zoneFormat(zone, options);
  const date = new Date(createdAt);
  const weekday = format({ weekday: 'long' }).format(date);
  const month = format({ month: 'long' }).format(date);
  const year = format({ year: 'numeric' }).format(date);
  const day = Number(
    format({ day: 'numeric' })
      .formatToParts(date)
      .find((part) => part.type === 'day')?.value ?? date.getUTCDate()
  );
  const stamp = `${weekday}, ${month} ${ordinal(day)}, ${year}`;
  return place ? `${stamp} ~ ${place}` : stamp;
}

/**
 * The one line of an entry the list shows: its first non-empty line of text,
 * capped so a long paragraph doesn't travel into the index. What fits is then
 * a matter of the reader's screen — the row fades it out at the edge.
 */
function previewLine(blocks) {
  for (const block of blocks) {
    if (block.kind !== 'text') continue;
    const line = (block.text ?? '')
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean);
    if (line) return line.length > 200 ? line.slice(0, 200) : line;
  }
  return '';
}

const THEME_CSS = `/* Public published site — mirrors the private app theme. No JavaScript. */
:root {
  --paper: rgb(253, 252, 248);
  --label: #000;
  --label-secondary: rgba(60, 60, 67, 0.6);
  --label-tertiary: rgba(60, 60, 67, 0.32);
  --separator: rgba(60, 60, 67, 0.18);
  --serif: "Iowan Old Style", ui-serif, ".New York", Palatino, "Palatino Linotype",
    "Hoefler Text", Charter, Georgia, "Times New Roman", serif;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --entry-size: 17px;
  --measure: 700px;
  --inset: 20px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #000;
    --label: #fff;
    --label-secondary: rgba(235, 235, 245, 0.6);
    --label-tertiary: rgba(235, 235, 245, 0.32);
    --separator: rgba(235, 235, 245, 0.16);
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  min-height: 100%;
  background: var(--paper);
  color: var(--label);
  font-family: var(--sans);
  font-size: 15px;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
.site {
  max-width: var(--measure);
  margin: 0 auto;
  padding: 28px max(var(--inset), env(safe-area-inset-left)) 64px;
  padding-right: max(var(--inset), env(safe-area-inset-right));
}
.site-title {
  margin: 0 0 28px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
/* The list mirrors the private app's read list: a quiet day header, then one
   row per entry — time and place above, the entry's first line below. */
.day-header {
  margin: 20px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--label-secondary);
}
.day-header:first-of-type { margin-top: 0; }
.entry-row {
  display: block;
  padding: 10px 0;
}
.entry-row:hover { text-decoration: none; opacity: 0.72; }
.entry-meta {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-bottom: 6px;
  font-size: 13px;
}
.entry-time {
  font-weight: 500;
  color: var(--label-secondary);
  white-space: nowrap;
}
.entry-place {
  color: var(--label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-text {
  font-family: var(--serif);
  font-size: var(--entry-size);
  line-height: 1.58;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, #000 90%, transparent);
  mask-image: linear-gradient(to right, #000 90%, transparent);
}
.media-hint {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--label-tertiary);
}
.stamp {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--label-secondary);
  font-weight: 500;
}
.entry-body p {
  font-family: var(--serif);
  font-size: var(--entry-size);
  line-height: 1.72;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0 0 1em;
}
.entry-body figure { margin: 0 0 1.25em; }
.entry-body img,
.entry-body video {
  display: block;
  width: 100%;
  height: auto;
  max-height: 80vh;
  object-fit: contain;
  background: rgba(127, 127, 127, 0.08);
}
.back {
  display: inline-block;
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--label-tertiary);
}
.empty { color: var(--label-tertiary); }
`;

/**
 * The stylesheet carries a hash of itself in its name. Published files are
 * served `immutable` for a year, which is only true of a name that changes
 * when the bytes do — a fixed `styles.css` would leave every reader who has
 * ever loaded the site with a stale theme and no way to ask for a new one.
 */
const THEME_FILE = `styles.${createHash('sha256').update(THEME_CSS).digest('hex').slice(0, 8)}.css`;

function pageShell({ title, body, siteBase }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeAttr(`${siteBase}/${THEME_FILE}`)}" />
</head>
<body>
<div class="site">
${body}
</div>
</body>
</html>
`;
}

async function copyOwnedMedia(userId, assetId, mediaOutDir, relativePrefix) {
  const row = q.mediaById.get(assetId, userId);
  if (!row) return null;
  const ext = MIME_EXT.get(row.mime) ?? (row.media_type === 'video' ? 'mp4' : 'bin');
  const filename = `${assetId}.${ext}`;
  await mkdir(mediaOutDir, { recursive: true });
  await copyFile(join(mediaDir, `${assetId}.bin`), join(mediaOutDir, filename));
  return {
    href: `${relativePrefix}${filename}`,
    mediaType: row.media_type,
    mime: row.mime,
  };
}

async function renderBlocks(userId, blocks, mediaOutDir, mediaPrefix) {
  const parts = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      const text = (block.text ?? '').trim();
      if (!text) continue;
      parts.push(`<p>${escapeHtml(text)}</p>`);
      continue;
    }
    if (block.kind !== 'media') continue;

    if (block.url) {
      const src = escapeAttr(block.url);
      if (block.media_type === 'video') {
        parts.push(`<figure><video controls playsinline src="${src}"></video></figure>`);
      } else {
        parts.push(`<figure><img src="${src}" alt="" /></figure>`);
      }
      continue;
    }

    if (!block.asset_id) continue;
    try {
      const copied = await copyOwnedMedia(userId, block.asset_id, mediaOutDir, mediaPrefix);
      if (!copied) continue;
      const src = escapeAttr(copied.href);
      if (copied.mediaType === 'video') {
        parts.push(`<figure><video controls playsinline src="${src}"></video></figure>`);
      } else {
        parts.push(`<figure><img src="${src}" alt="" /></figure>`);
      }
    } catch (error) {
      console.error('publish: media copy failed', block.asset_id, error);
    }
  }
  return parts.join('\n');
}

async function rebuildUser(user) {
  const username = user.username;
  const entries = q.publishedEntries.all(user.id);
  const userDir = join(publishedDir, username);
  const staging = join(publishedDir, `.tmp-${username}-${process.pid}`);

  await rm(staging, { recursive: true, force: true });

  if (entries.length === 0) {
    await rm(userDir, { recursive: true, force: true });
    return;
  }

  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, THEME_FILE), THEME_CSS);

    const siteBase = `/p/${username}`;
    const mediaOutDir = join(staging, 'media');
    const articles = [];

    for (const row of entries) {
      const slug = row.publish_slug;
      if (!slug) {
        console.error(`publish: skipping entry ${row.id} for ${username}: missing publish_slug`);
        continue;
      }
      const blocks = q.blocksFor.all(row.id);
      const zone = zoneOf(row.time_zone_id);
      const title = entryTitle(row.created_at, row.time_zone_id, row.loc_display_name);
      const bodyHtml = await renderBlocks(
        user.id,
        blocks,
        mediaOutDir,
        `${siteBase}/media/`
      );
      const articleBody = `<a class="back" href="${escapeAttr(`${siteBase}/`)}">← ${escapeHtml(username)}</a>
<h1 class="stamp">${escapeHtml(title)}</h1>
<div class="entry-body">
${bodyHtml || '<p class="empty"></p>'}
</div>`;
      await writeFile(
        join(staging, `${slug}.html`),
        pageShell({ title: `${title} · ${username}`, body: articleBody, siteBase })
      );
      articles.push({
        slug,
        title,
        zone,
        createdAt: row.created_at,
        place: row.loc_display_name ?? '',
        preview: previewLine(blocks),
        mediaCount: blocks.filter((block) => block.kind === 'media').length,
      });
    }

    if (articles.length === 0) {
      await rm(staging, { recursive: true, force: true });
      await rm(userDir, { recursive: true, force: true });
      return;
    }

    // Entries arrive newest first; a Map keeps the days in that order.
    const days = new Map();
    for (const article of articles) {
      const key = dayKey(article.createdAt, article.zone);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(article);
    }

    const listBody = [...days.values()]
      .map((group) => {
        const heading = dayHeading(group[0].createdAt, group[0].zone);
        const rows = group.map((article) => {
          const place = article.place
            ? `<span class="entry-place">·</span><span class="entry-place">${escapeHtml(article.place)}</span>`
            : '';
          const hint =
            article.mediaCount > 0
              ? `\n<span class="media-hint">${article.mediaCount === 1 ? '1 item' : `${article.mediaCount} items`}</span>`
              : '';
          // An entry that is nothing but pictures has no line to show; the
          // media hint is the whole of what the row says about it.
          const preview = article.preview
            ? `\n<p class="entry-text">${escapeHtml(article.preview)}</p>`
            : '';
          return `<a class="entry-row" href="${escapeAttr(`${siteBase}/${article.slug}`)}">
<div class="entry-meta"><span class="entry-time">${escapeHtml(timeLabel(article.createdAt, article.zone))}</span>${place}</div>${preview}${hint}
</a>`;
        });
        return `<h2 class="day-header">${escapeHtml(heading)}</h2>\n${rows.join('\n')}`;
      })
      .join('\n');

    const indexBody = `<h1 class="site-title">${escapeHtml(username)}</h1>
${listBody}`;
    await writeFile(
      join(staging, 'index.html'),
      pageShell({ title: username, body: indexBody, siteBase })
    );

    await rm(userDir, { recursive: true, force: true });
    await rename(staging, userDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Rebuild every user's public tree when publish_change_at is ahead of the last
 * successful finish. Failures wipe the affected user's tree (404) and log
 * loudly; last_success_at only advances after a fully clean pass.
 */
export async function runPublishJob() {
  if (!publishIsDirty()) return { ran: false };

  const started = now();
  console.log(`publish: rebuild starting (change pending since ${q.meta.get()?.change_at})`);
  let failed = false;

  const usernamesOnDisk = new Set();
  try {
    for (const name of await readdir(publishedDir)) {
      if (name.startsWith('.tmp-')) {
        await rm(join(publishedDir, name), { recursive: true, force: true });
        continue;
      }
      if (name.startsWith('.')) continue;
      usernamesOnDisk.add(name);
    }
  } catch {
    // publishedDir always exists after boot; ignore rare races.
  }

  for (const user of q.users.all()) {
    usernamesOnDisk.delete(user.username);
    try {
      await rebuildUser(user);
    } catch (error) {
      failed = true;
      console.error(`publish: FAILED rebuilding /p/${user.username}`, error);
    }
  }

  // Orphan trees (deleted users, renamed, etc.).
  for (const orphan of usernamesOnDisk) {
    try {
      await rm(join(publishedDir, orphan), { recursive: true, force: true });
    } catch (error) {
      failed = true;
      console.error(`publish: FAILED removing orphan /p/${orphan}`, error);
    }
  }

  if (failed) {
    console.error('publish: rebuild finished with errors — public trees may 404 until the next clean run');
    return { ran: true, ok: false };
  }

  q.markSuccess.run(started);
  console.log(`publish: rebuild ok in ${now() - started}ms`);
  return { ran: true, ok: true };
}

export function startPublishScheduler() {
  const tick = () => {
    runPublishJob().catch((error) => {
      console.error('publish: job crashed', error);
    });
  };
  tick();
  return setInterval(tick, PUBLISH_MS);
}
