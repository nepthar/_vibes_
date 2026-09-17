/** Small helpers shared by the API handlers. */

export class ApiError extends Error {
  constructor(status, message, { retryAfter } = {}) {
    super(message);
    this.status = status;
    // Seconds, sent as Retry-After when the response is written.
    this.retryAfter = retryAfter;
  }
}

export const badRequest = (message) => new ApiError(400, message);
export const unauthorized = (message = 'Not signed in') => new ApiError(401, message);
export const notFound = (message = 'Not found') => new ApiError(404, message);
export const conflict = (message) => new ApiError(409, message);
export const tooManyRequests = (message = 'Slow down', retryAfter = 1) =>
  new ApiError(429, message, { retryAfter });

/**
 * Runs `task` and holds the result until at least `ms` have passed, so how
 * long the work actually took tells the caller nothing. Failures are padded
 * too — a response that fails fast is as much of a signal as one that
 * succeeds slowly.
 */
export async function atLeast(ms, task) {
  const started = Date.now();
  try {
    return await task();
  } finally {
    const remaining = ms - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Collects a request body, capped so an oversized upload can't exhaust memory. */
export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJSON(req, limit = 2 * 1024 * 1024) {
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw badRequest('Malformed JSON');
  }
}
