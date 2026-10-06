import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, uuid, now } from './db.js';
import { badRequest, unauthorized } from './http.js';

const scrypt = promisify(scryptCb);

const KEY_LENGTH = 64;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Long enough that guessing is hopeless even without the rate limit in front
 * of it. There is no complexity rule to go with it: length is what actually
 * buys resistance, and character-class rules mostly buy `Passw0rd!`.
 */
export const MIN_PASSWORD_LENGTH = 10;

export const ACCOUNT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const insertUser = db.prepare(
  `INSERT INTO users (id, username, password_hash, created_at, remembered_granularity)
   VALUES (?, ?, ?, ?, 'city')`
);
const findUserByName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const insertSession = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const insertAccountToken = db.prepare(
  'INSERT INTO account_tokens (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const findAccountToken = db.prepare('SELECT * FROM account_tokens WHERE token = ?');
const deleteAccountToken = db.prepare('DELETE FROM account_tokens WHERE token = ?');
const deleteAccountTokensFor = db.prepare('DELETE FROM account_tokens WHERE username = ?');
const sweepAccountTokens = db.prepare('DELETE FROM account_tokens WHERE expires_at <= ?');
const setPasswordHash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const findSession = db.prepare(
  `SELECT users.* FROM sessions
   JOIN users ON users.id = sessions.user_id
   WHERE sessions.token = ? AND sessions.expires_at > ?`
);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const insertJournal = db.prepare(
  'INSERT INTO journals (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
);
const setActiveJournal = db.prepare('UPDATE users SET active_journal_id = ? WHERE id = ?');

/** scrypt with a per-user salt, stored as `scrypt$N$salt$hash`. */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, , saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * Accounts are invite-only, and the invite names the account: the operator
 * chooses the username when minting, so the person who receives the token
 * only ever chooses a password. No email, no verification.
 */
function validateUsername(username) {
  const name = String(username ?? '').trim();
  if (name.length < 2 || name.length > 32) {
    throw badRequest('Username must be 2–32 characters');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw badRequest('Username can use letters, numbers, dot, dash, underscore');
  }
  return name;
}

function validatePassword(password) {
  const secret = String(password ?? '');
  if (secret.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return secret;
}

/**
 * Mints a one-time account token for a username. The operator runs
 * `npm run account-token <username>` and hands the value to the person who
 * should hold that account. `exists` reports what the token will do when it is
 * redeemed: create the account, or reset the one already under that name.
 */
export function createAccountToken(username) {
  const name = validateUsername(username);
  sweepAccountTokens.run(now());
  const token = randomBytes(32).toString('base64url');
  const created = now();
  const expiresAt = created + ACCOUNT_TOKEN_TTL_MS;
  // One live token per name: minting again supersedes whatever was outstanding,
  // so a token handed out by mistake stops working the moment it is replaced.
  deleteAccountTokensFor.run(name);
  insertAccountToken.run(token, name, created, expiresAt);
  return { token, username: name, expiresAt, exists: !!findUserByName.get(name) };
}

/**
 * Reads a token back without spending it, so the setup screen can show the
 * name it carries before asking for a password.
 */
export function lookupAccountToken(accountToken) {
  const value = String(accountToken ?? '').trim();
  const row = findAccountToken.get(value);
  if (!row || row.expires_at <= now()) throw badRequest('Invalid or expired account token');
  return {
    username: row.username,
    exists: !!findUserByName.get(row.username),
    expiresAt: row.expires_at,
  };
}

/**
 * Redeems an account token: the name is the token's, the password is the
 * person's. A name with no account gets one; a name that already has an
 * account has it reset — the new password takes effect and every session
 * signed in under the old one is dropped, since whoever needed the reset is
 * exactly whoever might not control those sessions any more. The journal
 * itself is untouched.
 */
export async function setUpAccount({ accountToken, password }) {
  const value = String(accountToken ?? '').trim();
  const secret = validatePassword(password);
  // Fails early on a bad token so a hopeless request doesn't pay for a hash.
  const { username } = lookupAccountToken(value);
  const passwordHash = await hashPassword(secret);
  const timestamp = now();
  let created = false;

  // Token consume and account write share a transaction, so any failure puts
  // the token back. Re-read the token inside it: hashing took a moment, and
  // the token may have been spent or swept in the meantime.
  db.exec('BEGIN');
  try {
    const row = findAccountToken.get(value);
    if (!row || row.expires_at <= now()) throw badRequest('Invalid or expired account token');
    deleteAccountToken.run(value);
    const existing = findUserByName.get(row.username);
    if (existing) {
      setPasswordHash.run(passwordHash, existing.id);
      deleteUserSessions.run(existing.id);
    } else {
      const id = uuid();
      const journalId = uuid();
      insertUser.run(id, row.username, passwordHash, timestamp);
      // Every user starts with the default `personal` journal, active.
      insertJournal.run(journalId, id, 'personal', timestamp);
      setActiveJournal.run(journalId, id);
      created = true;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const user = findUserByName.get(username);
  return { ...issueToken(user), user: publicUser(user), created };
}

function issueToken(user) {
  const token = randomBytes(32).toString('base64url');
  const created = now();
  insertSession.run(token, user.id, created, created + SESSION_TTL);
  return { token, expiresAt: created + SESSION_TTL };
}

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  activeJournalId: user.active_journal_id,
  rememberedGranularity: user.remembered_granularity,
});

export async function login({ username, password }) {
  const name = String(username ?? '').trim();
  const user = findUserByName.get(name);
  // Same message either way — an attacker learns nothing about which
  // usernames exist.
  const failure = unauthorized('Invalid username or password');
  if (!user) throw failure;
  if (!(await verifyPassword(String(password ?? ''), user.password_hash))) throw failure;
  return { ...issueToken(user), user: publicUser(user) };
}

export function logout(token) {
  if (token) deleteSession.run(token);
}

export function tokenFrom(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

/** Resolves the bearer token presented on each API call to its user. */
export function authenticate(req) {
  const token = tokenFrom(req);
  if (!token) throw unauthorized();
  const user = findSession.get(token, now());
  if (!user) throw unauthorized('Session expired');
  return user;
}

export { publicUser };
