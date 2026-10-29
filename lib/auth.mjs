// Who may use the console. The token never appears in the page: a browser gets it once,
// from the link `cc-mission-control open` prints or opens, as an HttpOnly cookie; scripts
// such as the project-updates skill read it from the owner-only token file and send it as a header.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDataDir, writeFileAtomicSync } from './store.mjs';

export const TOKEN_RE = /^[0-9a-f]{32}$/;
export const tokenFile = (dir) => path.join(dir, 'token');

// Kept across restarts, so a browser that has the cookie stays signed in.
export function loadOrCreateToken(dir) {
  ensureDataDir(dir);
  const file = tokenFile(dir);
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (TOKEN_RE.test(t)) return t; } catch { /* first run */ }
  const t = crypto.randomBytes(16).toString('hex');
  try { writeFileAtomicSync(file, t, 0o600); } catch (e) {
    // Without the file, the server and `cc-mission-control open` can't agree on a token.
    console.error(`Could not save the console token to ${file} (${e.message}). Signing in will fail until that folder is writable.`);
  }
  return t;
}

export function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

// Cookies ignore ports, so each port gets its own cookie name.
export const cookieName = (port) => `ccmc_${port}`;

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const sessionCookie = (port, token) =>
  `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`;

export const localOrigins = (port) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

// Signed in by cookie (the page) or by the X-Console-Token header (scripts).
export function isAuthed(headers, port, token) {
  return tokenMatches(headers['x-console-token'], token) || tokenMatches(readCookie(headers.cookie, cookieName(port)), token);
}

// Requests that change something also need proof they came from the console's own page:
// either the token header, or the cookie plus a custom header (which another site can't add
// without a CORS preflight this server never answers) and, when sent, a matching Origin.
export function mayAct(headers, port, token) {
  if (tokenMatches(headers['x-console-token'], token)) return true;
  if (!tokenMatches(readCookie(headers.cookie, cookieName(port)), token)) return false;
  if (headers['x-console-request'] !== '1') return false;
  return !headers.origin || localOrigins(port).has(headers.origin);
}
