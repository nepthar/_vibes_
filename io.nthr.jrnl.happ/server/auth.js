import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, uuid, now } from './db.js';
import { badRequest, conflict, unauthorized } from './http.js';

const scrypt = promisify(scryptCb);

const KEY_LENGTH = 64;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Long enough that guessing is hopeless even without the rate limit in front
 * of it. There is no complexity rule to go with it: length is what actually
 * buys resistance, and character-class rules mostly buy `Passw0rd!`.
 */
export const MIN_PASSWORD_LENGTH = 10;

export const SIGNUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const insertUser = db.prepare(
  `INSERT INTO users (id, username, password_hash, created_at, remembered_granularity)
   VALUES (?, ?, ?, ?, 'city')`
);
const findUserByName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const insertSession = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const insertSignupToken = db.prepare(
  'INSERT INTO signup_tokens (token, created_at, expires_at) VALUES (?, ?, ?)'
);
const findSignupToken = db.prepare('SELECT * FROM signup_tokens WHERE token = ?');
const deleteSignupToken = db.prepare('DELETE FROM signup_tokens WHERE token = ?');
const sweepSignupTokens = db.prepare('DELETE FROM signup_tokens WHERE expires_at <= ?');
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
 * Mints a one-time signup token. The operator runs `npm run signup-token`
 * and hands the value to the person who should have an account.
 */
export function createSignupToken() {
  sweepSignupTokens.run(now());
  const token = randomBytes(32).toString('base64url');
  const created = now();
  const expiresAt = created + SIGNUP_TTL_MS;
  insertSignupToken.run(token, created, expiresAt);
  return { token, expiresAt };
}

/**
 * Account creation is invite-only: a username, a password, and a token
 * the operator minted. No email, no verification.
 */
function validateCredentials(username, password) {
  const name = String(username ?? '').trim();
  const secret = String(password ?? '');
  if (name.length < 2 || name.length > 32) {
    throw badRequest('Username must be 2–32 characters');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw badRequest('Username can use letters, numbers, dot, dash, underscore');
  }
  if (secret.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return { name, secret };
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

export async function signup({ username, password, signupToken }) {
  const { name, secret } = validateCredentials(username, password);
  if (findUserByName.get(name)) throw conflict('That username is taken');

  const invite = String(signupToken ?? '').trim();
  const passwordHash = await hashPassword(secret);
  const id = uuid();
  const timestamp = now();
  const journalId = uuid();

  // Token consume and user insert share a transaction so a unique-name
  // collision (or any other failure) puts the invite back.
  db.exec('BEGIN');
  try {
    const row = findSignupToken.get(invite);
    if (!row || row.expires_at <= now()) throw badRequest('Invalid or expired signup token');
    deleteSignupToken.run(invite);
    insertUser.run(id, name, passwordHash, timestamp);
    // Every user starts with the default `personal` journal, active.
    insertJournal.run(journalId, id, 'personal', timestamp);
    setActiveJournal.run(journalId, id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const user = findUserByName.get(name);
  return { ...issueToken(user), user: publicUser(user) };
}

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
