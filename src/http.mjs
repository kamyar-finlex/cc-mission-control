import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { isAuthed, mayAct, sessionCookie, tokenMatches } from '../lib/auth.mjs';
import { act } from './actions.mjs';
import { attachmentPath, saveAttachment } from './attachments.mjs';
import { AVATAR_DIR, avatarManifest, speakToFile, ttsWorker } from './avatar.mjs';
import { ROOT, IMAGE_TYPES, PORT, TOKEN } from './config.mjs';
import { digest } from './digest.mjs';
import { clients, send, sse, state, streamSession, tick } from './state.mjs';
import { images } from './transcript.mjs';

// The HTTP server: sign-in, security headers, routes and request bodies.

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// The page's one inline script runs under a per-request nonce; nothing else may run.
const csp = (nonce) => [
  "default-src 'self'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "font-src 'self' data:",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SIGN_IN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC Mission Control</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#222;background:#f4f3ef}
code{background:#e8e6df;padding:2px 6px;border-radius:4px}@media (prefers-color-scheme:dark){body{background:#1c1b19;color:#e8e6df}code{background:#33312c}}</style></head>
<body><h1>CC Mission Control</h1><p>This browser isn't signed in to the console yet. In a terminal, run:</p><p><code>cc-mission-control open</code></p>
<p>It opens this page with a one-time link that signs this browser in. The console shows every Claude Code transcript on this Mac and can start agents, so it only answers browsers that have signed in this way.</p></body></html>`;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* falls through */ }
  throw new HttpError(400, 'Expected a JSON object.');
}

function drainBounded(req, limit = 16e6) {
  let seen = 0;
  req.on('data', (c) => { seen += c.length; if (seen > limit) req.destroy(); });
  req.resume();
}

export const json = (res, value, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));

async function handle(req, res) {
  // Refuse DNS-rebinding and cross-site requests: this server can start agents.
  if (!LOCAL_HOSTS.has(req.headers.host || '')) { res.writeHead(403).end('forbidden host'); return; }
  res.setHeader('X-Console', 'cc-mission-control'); // lets `cc-mission-control open` tell the console from other servers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400).end('bad request'); return; }
  const p = url.pathname;
  const authed = isAuthed(req.headers, PORT, TOKEN);

  if (req.method === 'GET' && p === '/') {
    // The one-time link from `cc-mission-control open`: keep the token as a cookie and drop it from the address bar.
    const given = url.searchParams.get('token');
    if (given !== null) {
      if (!tokenMatches(given, TOKEN)) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(SIGN_IN_PAGE); return; }
      res.writeHead(303, { 'Set-Cookie': sessionCookie(PORT, TOKEN), Location: '/', 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (!authed) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(SIGN_IN_PAGE); return; }
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = (await fsp.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8')).replace('<script>', `<script nonce="${nonce}">`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp(nonce) }).end(html);
    return;
  }
  if (!authed) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('sign in first: run cc-mission-control open'); return; }

  if (req.method === 'GET' && p === '/events') {
    sse(res); send(res, 'state', state); clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})\/stream$/);
  if (req.method === 'GET' && m) { streamSession(req, res, m[1]); return; }

  if (req.method === 'GET' && p === '/api/whoami') { res.writeHead(204).end(); return; }
  if (req.method === 'GET' && p === '/api/digest') { json(res, digest(url.searchParams.get('range') || 'today')); return; }
  const img = p.match(/^\/api\/images\/([0-9a-f]{20})$/);
  if (req.method === 'GET' && img) {
    const im = images.get(img[1]);
    if (!im) { res.writeHead(404).end('image no longer cached; reopen the session'); return; }
    res.writeHead(200, { 'Content-Type': im.type, 'Cache-Control': 'private, max-age=86400' }).end(Buffer.from(im.data, 'base64'));
    return;
  }
  const att = p.match(/^\/api\/attachments\/([\w.-]+)$/);
  if (req.method === 'GET' && att) {
    const file = attachmentPath(att[1]);
    const ext = att[1].split('.').pop();
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0];
    try { if (!file || !type) throw new Error('bad name'); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }).end(await fsp.readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
    return;
  }
  if (req.method === 'GET' && p === '/api/avatar/manifest') {
    const man = await avatarManifest();
    if (!man) { res.writeHead(404).end('no avatar bank'); return; }
    json(res, man);
    return;
  }
  const av = p.match(/^\/api\/avatar\/((?:base\/\d{4})|(?:pass\d{1,2}))\.jpg$/);
  if (req.method === 'GET' && av) {
    try { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }).end(await fsp.readFile(path.join(AVATAR_DIR, `${av[1]}.jpg`))); }
    catch { res.writeHead(404).end('not found'); }
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404).end('not found'); return; }
  const a = p.match(/^\/api\/actions\/([a-z-]+)$/);
  const known = a || p === '/api/attach' || p === '/api/avatar/speak' || p === '/api/avatar/warm';
  if (!known) { res.writeHead(404).end('not found'); return; }
  if (!mayAct(req.headers, PORT, TOKEN)) { res.writeHead(403).end('bad token'); return; }

  if (p === '/api/avatar/speak' || p === '/api/avatar/warm') {
    const man = await avatarManifest();
    if (!man) { res.writeHead(404).end('no avatar bank'); return; }
    if (p === '/api/avatar/warm') { ttsWorker(); res.writeHead(204).end(); return; }
    const text = String((await readJson(req, 1e5)).text || '').slice(0, 800).trim();
    if (!text) { res.writeHead(400).end('no text'); return; }
    const r = await speakToFile(text, man.voice || 'bf_emma');
    if (!r.ok) { res.writeHead(503, { 'Content-Type': 'text/plain' }).end(r.error || 'speech failed'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).end(await fsp.readFile(r.out));
    return;
  }
  if (p === '/api/attach') {
    let body;
    try { body = await readJson(req, 15e6); } catch (e) { if (e.status === 413) { drainBounded(req); res.setHeader('Connection', 'close'); json(res, { ok: false, out: 'Images up to 10 MB only.' }); return; } throw e; }
    json(res, await saveAttachment(body.dataUrl));
    return;
  }
  const result = await act(a[1], await readJson(req, 1e6));
  setTimeout(tick, 300);
  json(res, result);
}

export const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!(e instanceof HttpError)) console.error(`${req.method} ${String(req.url).slice(0, 200)} failed:`, e);
    if (res.headersSent) { res.destroy(); return; }
    const status = e instanceof HttpError ? e.status : 500;
    // Up to 16 MB more of the request body is read and dropped, so the client gets this reply
    // instead of a reset connection; past that the socket is cut. The connection then closes.
    drainBounded(req);
    res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' }).end(e instanceof HttpError ? e.message : 'internal error');
  });
});
