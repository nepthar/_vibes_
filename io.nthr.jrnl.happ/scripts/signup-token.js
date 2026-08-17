/**
 * Issue a one-time signup token. Print it, hand it to the person who
 * should have an account; it lasts a week and is deleted when used.
 *
 *   node scripts/signup-token.js
 */

import { createSignupToken } from '../server/auth.js';

const { token, expiresAt } = createSignupToken();
console.error(`expires ${new Date(expiresAt).toISOString()}`);
console.log(token);
