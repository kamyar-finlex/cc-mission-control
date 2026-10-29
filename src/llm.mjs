import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadJson, saveJson } from '../lib/store.mjs';
import { CLAUDE_BIN, DATA_DIR } from './config.mjs';
import { linearScans } from './linear.mjs';
import { state } from './state.mjs';
import { sessionDigest, stitch } from './story.mjs';
import { clip } from './transcript.mjs';

// What Claude writes about a session (its story and its open items), and where that is kept.


const SUMMARY_FILE = path.join(DATA_DIR, 'stories.json');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
let written = loadJson(SUMMARY_FILE, {});
if (!isObj(written)) written = {};

export function storyFor(sid, s) {
  const st = linearScans.get(sid);
  const story = st?.story || { asks: [], recaps: [], compacts: [] };
  const turns = story.recaps.length;
  const w = written[sid];
  // The question is still open when no user message came after it.
  const lt = story.lastTurn;
  const lastAskTs = story.asks.at(-1)?.ts || 0;
  const waitingOn = lt && lt.ts >= lastAskTs ? { ask: lt.ask, actions: lt.actions, blocked: lt.blocked, recap: lt.recap, ts: lt.ts } : undefined;
  return {
    turns, asks: story.asks.length, waitingOn,
    written: w && { text: w.text, at: w.at, turns: w.turns, model: w.model, stale: w.turns < turns },
    stitched: stitch(story, s),
  };
}

// One paragraph written by Claude (Haiku) from the session's digest. Needs the
// terminal CLI to be logged in. Runs without tools, settings or saved history.
const writing = new Set();

// Haiku over stdin with no tools, no settings and no saved session.
async function runHaiku(prompt) {
  const out = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project'],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = '';
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on('data', (b) => { o += b; });
    child.stderr.on('data', (b) => { e += b; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, o: '', e: String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, o: o.trim(), e: e.trim() }); });
    child.stdin.end(prompt);
  });
  const authFailed = /not logged in|\/login|authenticate|oauth|invalid api key/i.test(out.o + out.e);
  if (out.code !== 0 || !out.o || authFailed)
    return { ok: false, out: authFailed ? 'The terminal claude CLI is logged out. Run `claude` in a terminal and /login once, then try again.' : `Claude failed: ${clip(out.e || out.o, 300)}` };
  return { ok: true, text: out.o };
}

export async function writeSummary(sid) {
  const s = state.sessions.find((x) => x.sessionId === sid);
  const st = linearScans.get(sid);
  if (!s || !st) return { ok: false, out: 'Session not found yet. Try again in a few seconds.' };
  if (writing.has(sid)) return { ok: false, out: 'Already writing this summary.' };
  const prompt = `Write ONE paragraph (90-160 words) telling the whole story of this Claude Code session: what the user wanted, the main steps and turning points, what was delivered (PRs, tickets), and where it stands now including anything still open. Plain prose, past tense for what happened, present tense for the current state. No headings, no bullet points, no preamble.\n\n${clip(sessionDigest(s, st), 24000)}`;
  writing.add(sid);
  try {
    const r = await runHaiku(prompt);
    if (!r.ok) return r;
    written[sid] = { text: r.text, at: Date.now(), turns: st.story.recaps.length, model: 'haiku' };
    await saveJson(SUMMARY_FILE, written);
    return { ok: true, out: 'Summary written.' };
  } finally { writing.delete(sid); }
}

const CHECK_FILE = path.join(DATA_DIR, 'open-items.json');
export let checks = loadJson(CHECK_FILE, {});
if (!isObj(checks)) checks = {};
const checking = new Set();

// Claude reads the whole digest and lists what is still open, each with a reply the user could send.
export async function checkOpen(sid) {
  const s = state.sessions.find((x) => x.sessionId === sid);
  const st = linearScans.get(sid);
  if (!s || !st) return { ok: false, out: 'Session not found yet. Try again in a few seconds.' };
  if (checking.has(sid)) return { ok: false, out: 'Already checking this session.' };
  const prompt = `You review a Claude Code session for its owner. List what is STILL OPEN: unfinished work, things blocked on someone, checks not yet run, PRs or tickets not done, and questions the session left unanswered. Ignore anything already resolved later in the session. For each item, write a short reply the owner could send to the session to move it forward.
Answer with JSON only, no prose and no code fence: {"done": boolean (true only if truly nothing is open), "items": [{"text": "what is open, one sentence", "who": "owner" | "session" | "someone else", "reply": "message to send to the session"}]} with at most 6 items, most important first.\n\n${clip(sessionDigest(s, st), 24000)}`;
  checking.add(sid);
  try {
    const r = await runHaiku(prompt);
    if (!r.ok) return r;
    let parsed;
    try { parsed = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch { return { ok: false, out: 'Claude did not answer in the expected format. Try again.' }; }
    checks[sid] = { done: !!parsed.done, items: (parsed.items || []).slice(0, 6).map((i) => ({ text: String(i.text || ''), who: i.who, reply: i.reply ? String(i.reply) : undefined })), at: Date.now(), turns: st.story.recaps.length };
    await saveJson(CHECK_FILE, checks);
    return { ok: true, out: 'Checked.' };
  } finally { checking.delete(sid); }
}
