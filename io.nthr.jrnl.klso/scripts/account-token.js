/**
 * Issue a one-time account token for a username. Print it, hand it to the
 * person who should hold that account; it lasts a week and is deleted when
 * used. A name with no account yet gets one; a name that already has an
 * account has it reset — a new password, every session signed out, entries
 * left alone. Minting again for the same name retires the previous token.
 *
 *   node scripts/account-token.js <username>
 */

import { createAccountToken } from '../server/auth.js';

const [username] = process.argv.slice(2);
if (!username) {
  console.error('usage: node scripts/account-token.js <username>');
  process.exit(1);
}

let issued;
try {
  issued = createAccountToken(username);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { token, expiresAt, exists } = issued;
console.error(
  `${exists ? 'resets' : 'creates'} ${username}; expires ${new Date(expiresAt).toISOString()}`
);
console.log(token);
