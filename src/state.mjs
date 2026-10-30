import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadJson, saveJson } from '../lib/store.mjs';
import { bySessionOrder } from '../public/js/util.js'; // shared with the page, which sorts patched sessions the same way
import { appIdToCli, appMeta } from './app-meta.mjs';
import { DATA_DIR, ROOT, USAGE_TASK_ID } from './config.mjs';
import { linearEpoch, linearFor, linearScans } from './linear.mjs';
import { checks, storyFor, written } from './llm.mjs';
import { prEpoch, prsFor } from './prs.mjs';
import { aliveReason, deploysFor, openItemsFor } from './story.mjs';
import { DISPLAY, clip, cwdForEnded, historyCutoff, parseLines, projectOf, readRegistry, readTail, refreshTranscript, scanTranscripts, summaryFor, transcripts } from './transcript.mjs';
import { readPlanLimits } from './usage.mjs';

// The board's state: building it from transcripts every tick, and pushing it to pages over SSE.

export let state = { sessions: [], at: 0 };
let uiVersion = '';

// Sessions hidden from the console. App sessions can only be archived inside the app.
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');
const archived = loadJson(ARCHIVE_FILE, []);
export const consoleArchive = new Set(Array.isArray(archived) ? archived.filter((x) => typeof x === 'string') : []);
export const saveArchive = () => saveJson(ARCHIVE_FILE, [...consoleArchive]);

async function buildState() {
  const reg = await readRegistry();
  const running = new Set();
  const sessions = [];
  for (const r of reg) {
    running.add(r.sessionId);
    if (!transcripts.has(r.sessionId)) await scanTranscripts();
    await refreshTranscript(r.sessionId);
    const s = await summaryFor(r.sessionId);
    const isApp = r.entrypoint === 'claude-desktop';
    const kind = r.kind === 'bg' ? 'background' : isApp ? 'app' : r.entrypoint === 'sdk-cli' || r.entrypoint === 'sdk-ts' ? 'sdk' : 'terminal';
    sessions.push({
      sessionId: r.sessionId, pid: r.pid, jobId: r.jobId, cwd: r.cwd, ...projectOf(r.cwd),
      kind, status: r.status || 'unknown', running: true,
      phase: r.status === 'busy' ? 'working' : 'waiting',
      title: r.name || s.title || s.firstUser || '(untitled)',
      startedAt: r.startedAt, statusSince: r.statusUpdatedAt, version: r.version,
      ...s, cwd: r.cwd, lastTs: Math.max(s.lastTs || 0, r.statusUpdatedAt || 0) || undefined,
    });
  }
  const cutoff = historyCutoff();
  for (const [sid, t] of transcripts) {
    if (running.has(sid) || t.mtime < cutoff || t.size < 200) continue;
    const s = await summaryFor(sid);
    if (!s.lastKind || (s.lastTs || t.mtime) < cutoff) continue; // nothing shown, or only bookkeeping was recent
    const cwd = s.cwd || await cwdForEnded(sid, t.file);
    sessions.push({
      sessionId: sid, cwd, ...projectOf(cwd), kind: 'ended', status: 'ended', running: false, phase: 'ended',
      title: s.title || s.firstUser || '(untitled)', ...s, cwd, lastTs: s.lastTs || t.mtime,
    });
  }
  // This tool's own usage-refresh runs are plumbing, not work to watch.
  for (let i = sessions.length - 1; i >= 0; i--) if (appMeta.get(sessions[i].sessionId)?.scheduledTaskId === USAGE_TASK_ID) sessions.splice(i, 1);
  sessions.sort(bySessionOrder);
  cardIds.clear();
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    // An ended session's card only changes when one of its inputs does; reuse it otherwise.
    const key = s.phase === 'ended' ? cardKey(s) : undefined;
    const hit = key && cards.get(s.sessionId);
    if (hit && hit.key === key) {
      if (VERIFY_CACHE) { const fresh = JSON.stringify(enrich(s)); if (fresh !== hit.json) console.error(`card cache stale for ${s.sessionId}`); }
      sessions[i] = hit.card;
      cardJson.set(hit.card, hit.json);
      continue;
    }
    enrich(s);
    if (key) { const json = JSON.stringify(s); cards.set(s.sessionId, { key, card: s, json }); cardJson.set(s, json); }
  }
  for (const id of cards.keys()) if (!cardIds.has(id)) cards.delete(id);
  return sessions;
}

// Everything an ended session's card is built from. Running sessions are always rebuilt.
const cards = new Map(); // sessionId -> { key, card, json }
const cardIds = new Set();
export const cardJson = new WeakMap(); // card -> its JSON, for diff()
const VERIFY_CACHE = process.env.CCMC_VERIFY_CACHE === '1'; // rebuild every cached card and report any difference
const ids = new WeakMap();
let nextId = 0;
const idOf = (o) => (o ? ids.get(o) ?? (ids.set(o, ++nextId), nextId) : 0);
function cardKey(s) {
  cardIds.add(s.sessionId);
  const t = transcripts.get(s.sessionId);
  const m = appMeta.get(s.sessionId);
  return [t?.size, t?.mtime, s.cwd, idOf(m), m && appIdToCli.get(m.parentAppId), consoleArchive.has(s.sessionId),
    linearScans.get(s.sessionId)?.offset, linearEpoch, prEpoch, idOf(written[s.sessionId]), idOf(checks[s.sessionId])].join('|');
}

function enrich(s) {
  {
    const m = appMeta.get(s.sessionId);
    if (m) {
      s.appId = m.appId;
      if (m.summary) s.summary = m.summary;
      if (m.needsAction) s.needsAction = m.needsAction;
      if (m.parentAppId) s.parentId = appIdToCli.get(m.parentAppId);
      if (m.archived) s.appArchived = true;
    }
    if (consoleArchive.has(s.sessionId)) s.archived = true;
    s.linear = linearFor(s.sessionId, s);
    s.story = storyFor(s.sessionId, s);
    const deploys = deploysFor(linearScans.get(s.sessionId));
    if (deploys.length) s.deploys = deploys;
    const prs = prsFor(s.sessionId);
    if (prs.length) s.prs = prs;
    if (s.phase === 'waiting') {
      s.openItems = openItemsFor(s, linearScans.get(s.sessionId));
      const c = checks[s.sessionId];
      if (c) s.openCheck = { ...c, stale: c.turns < (linearScans.get(s.sessionId)?.story.recaps.length || 0) };
      s.alive = s.openCheck?.items?.length && !s.story?.waitingOn?.ask
        ? { tone: 'wip', text: clip(s.openCheck.items[0].text, 130), more: s.openCheck.items.length - 1 }
        : { ...aliveReason(s, s.openItems), more: Math.max(0, s.openItems.length - 1) };
    }
  }
  return s;
}

// ---------- live push (SSE) ----------

export const clients = new Set();
export function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
}
export const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Changes whenever any page file does, so open pages reload themselves onto the new version.
// Checked at most every 5 s: it only changes when the console is updated.
let pageChecked = 0;
async function pageVersion() {
  if (uiVersion && Date.now() - pageChecked < 5000) return uiVersion;
  pageChecked = Date.now();
  const dir = path.join(ROOT, 'public');
  const files = ['index.html', 'app.css', ...(await fsp.readdir(path.join(dir, 'js'))).map((f) => `js/${f}`)];
  const times = await Promise.all(files.map(async (f) => (await fsp.stat(path.join(dir, f))).mtimeMs));
  return String(Math.max(...times));
}

// What the pages have: each session's JSON, and the usage and page version they last got.
let sentSessions = new Map();
let sentUsage = '';
let sentVersion = '';
function diff(sessions, usage) {
  const now = new Map();
  const upsert = [];
  for (const s of sessions) {
    const j = cardJson.get(s) ?? JSON.stringify(s);
    now.set(s.sessionId, j);
    if (sentSessions.get(s.sessionId) !== j) upsert.push(s);
  }
  const remove = [...sentSessions.keys()].filter((id) => !now.has(id));
  const usageJson = JSON.stringify(usage);
  const patch = {};
  if (upsert.length) patch.upsert = upsert;
  if (remove.length) patch.remove = remove;
  if (usageJson !== sentUsage) patch.usage = usage;
  if (uiVersion !== sentVersion) patch.uiVersion = uiVersion;
  sentSessions = now; sentUsage = usageJson; sentVersion = uiVersion;
  return Object.keys(patch).length ? patch : null;
}

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sessions = await buildState();
    const usage = { plan: await readPlanLimits() };
    try { uiVersion = await pageVersion(); } catch { /* keep */ }
    // Pages get the whole state once (on connect), then only what changed.
    const patch = diff(sessions, usage);
    if (patch) {
      state = { sessions, usage, uiVersion, at: Date.now() };
      for (const c of clients) send(c, 'patch', patch);
    }
  } catch (e) { console.error('tick failed', e); }
  finally { ticking = false; }
}

// Per-session transcript stream: backlog, then appended events as they land.
export function streamSession(req, res, sid) {
  const t = transcripts.get(sid);
  sse(res);
  if (!t) { send(res, 'backlog', []); return; }
  // offset: bytes read so far; carry: the bytes of a last line still being written (kept as bytes, so
  // a read that ends inside a multi-byte character is joined correctly).
  let offset = 0, carry = Buffer.alloc(0), closed = false, ready = false, busy = false;
  const shown = (text) => parseLines(text, { images: true }).filter((e) => DISPLAY.has(e.kind));
  // The latest part of the transcript; sent on open and again if the file is rewritten, which the
  // page treats as a fresh start (so nothing shown twice).
  const backlog = async () => {
    const { text, complete } = await readTail(t.file, 2 * 1024 * 1024);
    carry = Buffer.alloc(0);
    offset = complete; // an unfinished last line is read again, whole, by the next poll
    send(res, 'backlog', shown(text).slice(-300));
  };
  backlog().catch(() => send(res, 'backlog', [])).finally(() => { ready = true; });
  const timer = setInterval(async () => {
    if (closed || !ready || busy) return;
    busy = true;
    try {
      const st = await fsp.stat(t.file);
      if (st.size < offset) { await backlog(); return; } // rewritten
      if (st.size === offset) return;
      const fh = await fsp.open(t.file, 'r');
      let bytesRead = 0;
      const buf = Buffer.alloc(st.size - offset);
      try { ({ bytesRead } = await fh.read(buf, 0, buf.length, offset)); } finally { await fh.close(); }
      offset += bytesRead;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const cut = data.lastIndexOf(0x0a) + 1;
      carry = data.subarray(cut);
      const events = shown(data.subarray(0, cut).toString('utf8'));
      if (events.length) send(res, 'append', events);
    } catch { /* transient */ }
    finally { busy = false; }
  }, 700);
  req.on('close', () => { closed = true; clearInterval(timer); });
}
