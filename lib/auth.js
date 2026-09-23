// Passwords are hashed with scrypt and a per-user salt. Session tokens are 32
// random bytes handed to the browser once; the server only ever stores their
// SHA-256, so a leaked store does not leak live sessions.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_DAYS = 14;
export const COOKIE = 'tw_session';

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 32, SCRYPT);
  return { salt, hash: key.toString('hex') };
}

export async function checkPassword(password, salt, expected) {
  const { hash } = await hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

// Email is the login, so it is the lookup key. It is stored hashed in the key
// name so listing the store does not enumerate addresses.
export const emailKey = (email) => `user/${sha256(normaliseEmail(email))}`;
export const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

export function validEmail(e) {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(e);
}

export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Use at least 10 characters.';
  if (p.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(p)) return 'That password is one character repeated.';
  return null;
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function sessionCookie(value, { secure, maxAge = SESSION_DAYS * 86400 }) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}
