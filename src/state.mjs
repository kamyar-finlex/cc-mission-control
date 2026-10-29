import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadJson, saveJson } from '../lib/store.mjs';
import { appIdToCli, appMeta } from './app-meta.mjs';
import { DATA_DIR, ROOT, USAGE_TASK_ID } from './config.mjs';
import { linearFor, linearScans } from './linear.mjs';
import { checks, storyFor } from './llm.mjs';
import { prsFor } from './prs.mjs';
import { aliveReason, deploysFor, openItemsFor } from './story.mjs';
import { DISPLAY, clip, cwdForEnded, historyCutoff, parseLines, projectOf, readRegistry, readTail, refreshTranscript, scanTranscripts, summaryFor, transcripts } from './transcript.mjs';
import { readPlanLimits } from './usage.mjs';

// The board's state: building it from transcripts every tick, and pushing it to pages over SSE.

export let state = { sessions: [], at: 0 };
let uiVersion = '';
let stateJson = '';

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
  sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  for (const s of sessions) {
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
  return sessions;
}

// ---------- live push (SSE) ----------

export const clients = new Set();
export function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
}
export const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Changes whenever any page file does, so open pages reload themselves onto the new version.
async function pageVersion() {
  const dir = path.join(ROOT, 'public');
  const files = ['index.html', 'app.css', ...(await fsp.readdir(path.join(dir, 'js'))).map((f) => `js/${f}`)];
  const times = await Promise.all(files.map(async (f) => (await fsp.stat(path.join(dir, f))).mtimeMs));
  return String(Math.max(...times));
}

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sessions = await buildState();
    const usage = { plan: await readPlanLimits() };
    try { uiVersion = await pageVersion(); } catch { /* keep */ }
    const json = JSON.stringify({ sessions, usage, uiVersion });
    if (json !== stateJson) {
      stateJson = json;
      state = { sessions, usage, uiVersion, at: Date.now() };
      for (const c of clients) send(c, 'state', state);
    }
  } catch (e) { console.error('tick failed', e); }
  finally { ticking = false; }
}

// Per-session transcript stream: backlog, then appended events as they land.
export function streamSession(req, res, sid) {
  const t = transcripts.get(sid);
  sse(res);
  if (!t) { send(res, 'backlog', []); return; }
  let offset = 0, carry = '', closed = false;
  (async () => {
    const { text, size } = await readTail(t.file, 2 * 1024 * 1024);
    offset = size;
    send(res, 'backlog', parseLines(text, { images: true }).filter((e) => DISPLAY.has(e.kind)).slice(-300));
  })().catch(() => send(res, 'backlog', []));
  const timer = setInterval(async () => {
    if (closed || !offset) return;
    try {
      const st = await fsp.stat(t.file);
      if (st.size < offset) offset = 0; // rewritten
      if (st.size === offset) return;
      const fh = await fsp.open(t.file, 'r');
      const buf = Buffer.alloc(st.size - offset);
      await fh.read(buf, 0, buf.length, offset);
      await fh.close();
      offset = st.size;
      const text = carry + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      carry = text.slice(cut + 1);
      const events = parseLines(text.slice(0, cut + 1), { images: true }).filter((e) => DISPLAY.has(e.kind));
      if (events.length) send(res, 'append', events);
    } catch { /* transient */ }
  }, 700);
  req.on('close', () => { closed = true; clearInterval(timer); });
}
