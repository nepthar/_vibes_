/**
 * The reverse proxy is the TLS terminator. This process only accepts
 * requests whose Host header is the public name it was given at boot —
 * so it will not answer to a raw IP, an internal hostname, or a
 * DNS-rebinding trick.
 *
 * `JRNL_HOST` is the only source, and it is required: a process that cannot
 * tell which name it is supposed to answer to has no business guessing. Set it
 * to the public hostname (`journal.example.com`), or to the literal `any` to
 * accept every Host — which is for local development, and says so out loud
 * rather than happening by default when a variable goes missing.
 */

export const ANY_HOST = 'any';

export function expectedHost() {
  const raw = process.env.JRNL_HOST?.trim();
  if (!raw) return null;
  return raw.replace(/^https:\/\//i, '').replace(/\/+$/, '') || null;
}

/**
 * Checked once at boot. Returns the configured value, or throws with the
 * fix in the message — an unset JRNL_HOST must stop the process, not quietly
 * disable the guard.
 */
export function requireExpectedHost() {
  const value = expectedHost();
  if (!value) {
    throw new Error(
      'JRNL_HOST is not set. Set it to the public hostname this instance ' +
        'answers to (e.g. JRNL_HOST=journal.example.com), or to "any" to ' +
        'accept every Host header for local development.'
    );
  }
  return value;
}

/**
 * Split a Host header or JRNL_HOST value into hostname + optional port.
 * IPv6 literals (`[::1]:8787`) are handled; a trailing DNS dot is stripped.
 */
export function parseHost(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;

  let hostname;
  let port = null;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return null;
    hostname = raw.slice(1, close);
    if (raw[close + 1] === ':') port = raw.slice(close + 2);
    else if (raw.length !== close + 1) return null;
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) {
      hostname = raw.slice(0, colon);
      port = raw.slice(colon + 1);
    } else {
      hostname = raw;
    }
  }

  hostname = hostname.replace(/\.$/, '');
  if (!hostname || (port !== null && port === '')) return null;
  return { hostname, port };
}

/**
 * `any` accepts every Host. Otherwise the request hostname must match, and a
 * port on JRNL_HOST is required if present; without one any port is fine
 * (`journal.example.com` matches `:443` too). An absent or unparseable
 * expectation refuses everything — the guard fails closed.
 */
export function hostAllowed(requestHost, expected = expectedHost()) {
  if (!expected) return false;
  if (expected.trim().toLowerCase() === ANY_HOST) return true;
  const got = parseHost(requestHost);
  const want = parseHost(expected);
  if (!got || !want) return false;
  if (got.hostname !== want.hostname) return false;
  if (want.port !== null && got.port !== want.port) return false;
  return true;
}
