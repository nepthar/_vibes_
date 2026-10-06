import { createReadStream } from 'node:fs';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db, mediaDir, uuid, now } from './db.js';
import { badRequest, notFound, readBody } from './http.js';

/**
 * Media storage. The iOS app stores a PhotoKit pointer and
 * resolves bytes from the device library; a browser has no such library, so
 * the bytes are uploaded here and a block stores this row's id in place of the
 * asset identifier. Everything downstream — media as its own paragraph,
 * full-width aspect-fit rendering, the "no longer available" placeholder — is
 * unchanged.
 */

const MAX_BYTES = 32 * 1024 * 1024;

const MIME_TYPES = new Map([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/gif', 'photo'],
  ['image/webp', 'photo'],
  ['image/heic', 'photo'],
  ['image/avif', 'photo'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
  ['video/webm', 'video'],
]);

const insertMedia = db.prepare(
  `INSERT INTO media (id, user_id, media_type, mime, byte_size, pixel_width, pixel_height, duration, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const findMedia = db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?');

const filePath = (id) => join(mediaDir, `${id}.bin`);

const intHeader = (req, name) => {
  const value = Number(req.headers[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

/**
 * Upload is a raw binary PUT rather than a multipart form: the client already
 * has the File and its dimensions, so there is nothing a form encoding would
 * add but a parser.
 */
export async function uploadMedia(req, user) {
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const mediaType = MIME_TYPES.get(mime);
  if (!mediaType) throw badRequest(`Unsupported media type: ${mime || 'unknown'}`);

  const bytes = await readBody(req, MAX_BYTES);
  if (bytes.length === 0) throw badRequest('Empty upload');

  const id = uuid();
  await writeFile(filePath(id), bytes);

  const duration = Number(req.headers['x-duration']);
  insertMedia.run(
    id,
    user.id,
    mediaType,
    mime,
    bytes.length,
    intHeader(req, 'x-pixel-width'),
    intHeader(req, 'x-pixel-height'),
    Number.isFinite(duration) && duration > 0 ? duration : null,
    now()
  );

  return {
    assetId: id,
    mediaType,
    mime,
    pixelWidth: intHeader(req, 'x-pixel-width') ?? 0,
    pixelHeight: intHeader(req, 'x-pixel-height') ?? 0,
  };
}

/**
 * Streams media bytes back to the owner. Range requests are honoured so video
 * scrubbing works. A row whose file has gone missing 404s, which the client
 * renders as the quiet placeholder rather than an error.
 */
export async function serveMedia(req, res, user, id) {
  const row = findMedia.get(id, user.id);
  if (!row) throw notFound('No such media');

  const path = filePath(id);
  let size;
  try {
    ({ size } = await stat(path));
  } catch {
    throw notFound('Media file is gone');
  }

  const headers = {
    'Content-Type': row.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start <= end && start < size)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(path).pipe(res);
}
