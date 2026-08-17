import { tooManyRequests } from './http.js';

/**
 * One token bucket for the whole process — every request, static and API.
 *
 * Sized so ten devices can keep an entry open at once. Each posts scratch
 * every 800ms (12.5 rps); a cold load is ~15 files; commits, geo, and
 * media sit on top. 30 rps with a burst of 80 covers that with room for
 * a couple of people opening the app while others type.
 */

export const RATE_RPS = Number(process.env.JRNL_RATE_RPS) || 30;
export const RATE_BURST = Number(process.env.JRNL_RATE_BURST) || 80;

/**
 * Credential checks get their own, much tighter bucket on top of the global
 * one. Signing in is a once-a-month act for a human and a hot loop for someone
 * guessing passwords, so one per second costs a real user nothing and puts a
 * password-spraying run into the range of years.
 */
export const AUTH_RPS = Number(process.env.JRNL_AUTH_RPS) || 1;
export const AUTH_BURST = Number(process.env.JRNL_AUTH_BURST) || 1;

export function createLimiter({ rps = RATE_RPS, burst = RATE_BURST, now = Date.now } = {}) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const at = now();
      tokens = Math.min(burst, tokens + (Math.max(0, at - last) / 1000) * rps);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export const limiter = createLimiter();
export const authLimiter = createLimiter({ rps: AUTH_RPS, burst: AUTH_BURST });

/**
 * Admission control for geocoding, which is not rate-limited so much as
 * queued: upstream allows one call per 1.1s, so an unbounded queue turns a
 * burst into minutes of latency for everyone, holding a socket per waiting
 * request. Past MAX_INFLIGHT the answer is an immediate 429.
 *
 * The slot is claimed for a whole request and *before* the geo cache is
 * consulted. A cached lookup costs nothing, so it is tempting to wave it
 * through — but then a 429 would mean "this coordinate is not cached" and hand
 * back exactly the cross-user oracle the shared cache is padded to hide. Load
 * decides who is refused; never what is in the cache.
 */
export const MAX_INFLIGHT = Number(process.env.JRNL_GEO_QUEUE) || 10;

let inflight = 0;

export function reserve() {
  if (inflight >= MAX_INFLIGHT) throw tooManyRequests('Geocoding is busy');
  inflight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight -= 1;
  };
}
