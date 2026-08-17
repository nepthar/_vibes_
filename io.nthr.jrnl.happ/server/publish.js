import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

/** Title line in the entry's own zone — matches the private app stamp. */
function entryTitle(createdAt, timeZoneId, place) {
  const zone = timeZoneId && String(timeZoneId).trim() ? String(timeZoneId) : 'UTC';
  const format = (options) => {
    try {
      return new Intl.DateTimeFormat('en', { timeZone: zone, ...options });
    } catch {
      return new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...options });
    }
  };
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
.entry-list { list-style: none; margin: 0; padding: 0; }
.entry-list li { border-top: 1px solid var(--separator); }
.entry-list a {
  display: block;
  padding: 14px 0;
  font-size: 15px;
  line-height: 1.45;
}
.entry-list a:hover { text-decoration: none; opacity: 0.72; }
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

function pageShell({ title, body, siteBase }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeAttr(`${siteBase}/styles.css`)}" />
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
    await writeFile(join(staging, 'styles.css'), THEME_CSS);

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
      articles.push({ slug, title });
    }

    if (articles.length === 0) {
      await rm(staging, { recursive: true, force: true });
      await rm(userDir, { recursive: true, force: true });
      return;
    }

    const listItems = articles
      .map(
        (article) =>
          `<li><a href="${escapeAttr(`${siteBase}/${article.slug}`)}">${escapeHtml(article.title)}</a></li>`
      )
      .join('\n');

    const indexBody = `<h1 class="site-title">${escapeHtml(username)}</h1>
<ul class="entry-list">
${listItems}
</ul>`;
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
