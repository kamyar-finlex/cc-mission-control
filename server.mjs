#!/usr/bin/env node
// CC Mission Control: one live control room for every local Claude Code session.
// Unofficial and not affiliated with Anthropic.
// Zero dependencies. Reads ~/.claude/sessions (live registry) and
// ~/.claude/projects (transcripts); drives sessions through the `claude` CLI.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 7777;
const HOST = '127.0.0.1';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJ_DIR = path.join(CLAUDE_DIR, 'projects');
// Everything this tool writes lives here.
const DATA_DIR = process.env.CCMC_DATA_DIR || path.join(CLAUDE_DIR, 'cc-mission-control');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USAGE_TASK_ID = 'cc-mission-control-usage';
const APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const RECENT_HOURS = Number(process.env.RECENT_HOURS) || 0;
const TAIL_BYTES = 768 * 1024;
// Kept across restarts (owner-only file), so open pages keep working after the server restarts.
const TOKEN = (() => {
  const file = path.join(DATA_DIR, 'token');
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(t)) return t; } catch { /* first run */ }
  const t = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(file, t, { mode: 0o600 }); } catch { /* falls back to a per-run token */ }
  return t;
})();
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- transcript parsing ----------

const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const stripReminders = (s) =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function toolSummary(name, input = {}) {
  const v =
    input.command || input.file_path || input.pattern || input.url || input.query ||
    input.description || input.prompt || input.skill || input.to || input.title;
  if (typeof v === 'string') return clip(v.replace(/\s+/g, ' '), 200);
  const keys = Object.keys(input);
  return keys.length ? clip(JSON.stringify(input), 200) : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

// Transcript images are kept by content hash, so events carry a short id and the page loads the picture by URL.
const images = new Map(); // hash -> { type, data (base64) }
function keepImage(src) {
  if (src?.type !== 'base64' || typeof src.data !== 'string') return undefined;
  const h = crypto.createHash('sha1').update(src.data).digest('hex').slice(0, 20);
  if (!images.has(h)) {
    images.set(h, { type: src.media_type || 'image/png', data: src.data });
    if (images.size > 150) images.delete(images.keys().next().value);
  }
  return h;
}
const imagesIn = (content, opts) => (opts.images && Array.isArray(content) ? content.filter((c) => c?.type === 'image').map((c) => keepImage(c.source)).filter(Boolean) : []);

// One transcript line -> zero or more display events.
function toEvents(d, opts = {}) {
  const ts = d.timestamp ? Date.parse(d.timestamp) : undefined;
  const out = [];
  if (d.isSidechain) return out;
  if (d.type === 'user' && d.message) {
    const c = d.message.content;
    if (typeof c === 'string') {
      const t = stripReminders(c);
      if (t && !d.isMeta) out.push({ kind: 'user', text: clip(t, 4000), ts });
    } else if (Array.isArray(c)) {
      const texts = [];
      for (const b of c) {
        if (b.type === 'tool_result') {
          const imgs = imagesIn(b.content, opts);
          out.push({ kind: 'result', text: clip(stripReminders(resultText(b.content)), 1200), error: !!b.is_error, id: b.tool_use_id, ts, ...(imgs.length && { images: imgs }) });
        } else if (b.type === 'text' && !d.isMeta) {
          const t = stripReminders(b.text);
          if (t) texts.push(t);
        }
      }
      // A user message's text and pictures stay together as one bubble.
      const imgs = d.isMeta ? [] : imagesIn(c, opts);
      const hasImage = !d.isMeta && c.some((b) => b.type === 'image');
      if (texts.length || hasImage) out.push({ kind: 'user', text: clip(texts.join('\n\n'), 4000) || (imgs.length ? '' : '[image]'), ts, ...(imgs.length && { images: imgs }) });
    }
  } else if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
    const usage = d.message.usage;
    const ctx = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : undefined;
    for (const b of d.message.content) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'assistant', text: clip(b.text, 6000), ts, model: d.message.model, ctx });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', name: b.name, text: toolSummary(b.name, b.input), id: b.id, ts, model: d.message.model, ctx });
    }
  } else if (d.type === 'custom-title' || d.type === 'agent-name') {
    out.push({ kind: 'title', text: d.customTitle || d.agentName });
  }
  if (d.gitBranch && d.gitBranch !== 'HEAD') out.push({ kind: 'branch', text: d.gitBranch });
  if (d.cwd) out.push({ kind: 'cwd', text: d.cwd });
  return out;
}

const DISPLAY = new Set(['user', 'assistant', 'tool', 'result']);

function parseLines(text, opts) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { events.push(...toEvents(JSON.parse(line), opts)); } catch { /* partial line */ }
  }
  return events;
}

async function readTail(file, bytes = TAIL_BYTES) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size };
  } finally { await fh.close(); }
}

function summarize(events) {
  const s = {};
  for (const e of events) {
    if (e.kind === 'title') s.title = e.text;
    else if (e.kind === 'branch') s.branch = e.text;
    else if (e.kind === 'cwd') s.cwd = e.text;
    else if (e.kind === 'user') { s.lastUser = clip(e.text, 300); s.firstUser ??= clip(e.text, 120); }
    else if (e.kind === 'assistant') s.lastAssistant = clip(e.text, 300);
    if (e.kind === 'tool') s.lastTool = `${e.name.replace(/^mcp__.*__/, '')} · ${clip(e.text, 140)}`;
    if (e.model && e.model !== '<synthetic>') s.model = e.model;
    if (e.ctx) s.ctx = e.ctx;
    if (DISPLAY.has(e.kind) && e.ts) s.lastTs = e.ts;
    if (DISPLAY.has(e.kind)) s.lastKind = e.kind;
  }
  return s;
}

// ---------- session discovery ----------

const transcripts = new Map(); // sessionId -> { file, mtime, size }
const summaries = new Map(); // sessionId -> { size, summary }

async function scanTranscripts() {
  let dirs = [];
  try { dirs = await fsp.readdir(PROJ_DIR); } catch { return; }
  await Promise.all(dirs.map(async (dir) => {
    let files = [];
    try { files = await fsp.readdir(path.join(PROJ_DIR, dir)); } catch { return; }
    await Promise.all(files.filter((f) => f.endsWith('.jsonl')).map(async (f) => {
      const file = path.join(PROJ_DIR, dir, f);
      try {
        const st = await fsp.stat(file);
        transcripts.set(f.slice(0, -6), { file, mtime: st.mtimeMs, size: st.size });
      } catch { /* removed meanwhile */ }
    }));
  }));
}

async function refreshTranscript(sid) {
  const t = transcripts.get(sid);
  if (!t) return;
  try { const st = await fsp.stat(t.file); t.mtime = st.mtimeMs; t.size = st.size; } catch { /* ignore */ }
}

async function summaryFor(sid) {
  const t = transcripts.get(sid);
  if (!t) return {};
  const cached = summaries.get(sid);
  if (cached && cached.size === t.size) return cached.summary;
  try {
    const { text, size } = await readTail(t.file);
    const summary = summarize(parseLines(text));
    summaries.set(sid, { size, summary });
    return summary;
  } catch { return cached?.summary || {}; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function readRegistry() {
  let files = [];
  try { files = await fsp.readdir(SESS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const r = JSON.parse(await fsp.readFile(path.join(SESS_DIR, f), 'utf8'));
      if (r.sessionId && alive(r.pid)) out.push(r);
    } catch { /* being rewritten */ }
  }
  return out;
}

const projectOf = (cwd = '') => {
  const m = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/);
  return m ? { project: path.basename(m[1]), worktree: m[2] } : { project: path.basename(cwd) || cwd };
};

const cwdFromTranscriptDir = (file) => path.basename(path.dirname(file));

// ---------- Linear ----------
// No Linear API calls: tickets are learned from what sessions already fetched
// through the Linear MCP (get_issue / save_issue / list_issues results).

const LINEAR_TOOL = /__(get_issue|save_issue|list_issues|get_project|save_project|list_projects)$/;
const ISSUE_ID = /\b([A-Z][A-Z0-9]{1,5})-(\d{1,6})\b/g;
const ISSUE_URL = /linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,5}-\d{1,6})/g;
const IS_ISSUE_ID = /^[A-Z][A-Z0-9]{1,5}-\d{1,6}$/;
const catalog = new Map(); // "ENG-123" -> issue facts, freshest updatedAt wins
const projectInfo = new Map(); // project name -> { name, url, status }
const teamKeys = new Set(); // ticket prefixes Linear has confirmed, e.g. ENG
const projectNames = new Set(); // real project names (ids and slugs from tool inputs are not)
const linearScans = new Map(); // sessionId -> incremental scan state

// Some Linear replies carry HTML-escaped names ("A &amp; B"); keep the real text.
const unescapeHtml = (t) => t.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const nameOf = (v) => { const n = typeof v === 'string' ? v : v && typeof v === 'object' ? v.name || v.displayName || v.email : undefined; return typeof n === 'string' ? unescapeHtml(n) : n; };

function learn(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return;
  if (Array.isArray(o)) { for (const x of o) learn(x, depth + 1); return; }
  if (typeof o.id === 'string' && IS_ISSUE_ID.test(o.id) && typeof o.title === 'string') {
    const prev = catalog.get(o.id);
    if (!prev || (o.updatedAt || '') >= (prev.updatedAt || '')) {
      const next = {
        id: o.id, title: o.title, url: o.url, status: nameOf(o.status), statusType: o.statusType,
        project: nameOf(o.project), priority: nameOf(o.priority), assignee: nameOf(o.assignee),
        labels: Array.isArray(o.labels) ? o.labels.map(nameOf).filter(Boolean) : undefined,
        parentId: o.parentId, updatedAt: o.updatedAt,
      };
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
      catalog.set(o.id, { ...prev, ...next });
      if (next.project) projectNames.add(next.project);
    }
    teamKeys.add(o.id.split('-')[0]);
  } else if (typeof o.name === 'string' && typeof o.url === 'string' && o.url.includes('linear.app/') && o.url.includes('/project/')) {
    const name = unescapeHtml(o.name);
    projectInfo.set(name, { name, url: o.url, status: nameOf(o.status) });
    projectNames.add(name);
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') learn(v, depth + 1);
}

function mentions(text, st, weight) {
  for (const [, p, n] of text.matchAll(ISSUE_ID)) ref(st, `${p}-${n}`, weight);
  for (const [, id] of text.matchAll(ISSUE_URL)) { const up = id.toUpperCase(); ref(st, up, weight + 1); teamKeys.add(up.split('-')[0]); }
}
// Scores a ticket mention and remembers when the session last touched it.
function ref(st, id, weight) {
  bump(st.refs, id, weight);
  if (st.curTs) st.refsAt.set(id, Math.max(st.refsAt.get(id) || 0, st.curTs));
}
const bump = (map, key, n) => map.set(key, (map.get(key) || 0) + n);

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
function prMentions(text, st, weight) {
  for (const [, owner, repo, n] of text.matchAll(PR_URL)) bump(st.prs, `${owner}/${repo}#${n}`, weight);
}

// The story of a session: what was asked first, then each turn's recap (the
// app's wrap_up), plus any compaction summaries.
function storyLine(d, st) {
  const c = d.message?.content;
  if (d.type === 'user' && !d.isMeta) {
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    const clean = stripReminders(text);
    if (!clean) return;
    if (d.isCompactSummary) { st.story.compacts.push({ ts: Date.parse(d.timestamp) || 0, text: clip(clean, 1500) }); return; }
    if (clean.startsWith('<') || clean.startsWith('[Request interrupted')) return; // injected events, not the user's words
    st.story.asks.push({ ts: Date.parse(d.timestamp) || 0, text: clip(clean.replace(/\s+/g, ' '), 400) });
  } else if (d.type === 'assistant' && Array.isArray(c)) {
    for (const b of c) if (b.type === 'tool_use' && /(^|__)wrap_up$/.test(b.name) && typeof b.input?.recap === 'string') {
      const ts = Date.parse(d.timestamp) || 0;
      st.story.recaps.push({ ts, text: b.input.recap.trim() });
      // The turn's closing question and its suggested replies, if it asked one.
      const actions = Array.isArray(b.input.actions) ? b.input.actions
        .filter((a) => a && typeof a.label === 'string')
        .map((a) => ({ label: a.label, message: typeof a.message === 'string' ? a.message : a.label, app: typeof a.action === 'string' ? a.action : undefined })) : [];
      st.story.lastTurn = { ts, recap: b.input.recap.trim(), ask: typeof b.input.ask === 'string' ? b.input.ask : undefined, actions, blocked: !!b.input.blocked };
    }
  }
}

function linearLine(line, st) {
  const storyish = line.includes('wrap_up') || line.includes('isCompactSummary') || (line.includes('"type":"user"') && !line.includes('"tool_result"'));
  if (!storyish && !/[A-Z]{2}-\d|linear|\/pull\//.test(line)) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (d.isSidechain) return;
  if (d.timestamp) st.curTs = Date.parse(d.timestamp) || st.curTs;
  if (storyish) storyLine(d, st);
  const c = d.message?.content;
  if (d.type === 'user') {
    if (typeof c === 'string') { if (!d.isMeta) { mentions(stripReminders(c), st, 3); prMentions(c, st, 3); } return; }
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (b.type === 'text' && !d.isMeta) { mentions(stripReminders(b.text), st, 3); prMentions(b.text, st, 3); }
      else if (b.type === 'tool_result' && st.pending.has(b.tool_use_id)) {
        st.pending.delete(b.tool_use_id);
        try { learn(JSON.parse(resultText(b.content))); } catch { /* error text, not JSON */ }
      } else if (b.type === 'tool_result' && st.prCreates.has(b.tool_use_id)) {
        st.prCreates.delete(b.tool_use_id);
        prMentions(resultText(b.content), st, 20); // this session opened it
      }
    }
  } else if (d.type === 'assistant' && Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') { mentions(b.text, st, 1); prMentions(b.text, st, 2); }
      else if (b.type === 'tool_use' && typeof b.input?.command === 'string' && /\bgh pr create\b/.test(b.input.command)) st.prCreates.add(b.id);
      else if (b.type === 'tool_use' && LINEAR_TOOL.test(b.name)) {
        st.pending.set(b.id, b.name);
        const i = b.input || {};
        const w = b.name.endsWith('save_issue') ? 8 : 5;
        for (const v of [i.id, i.issueId, i.parentId]) if (typeof v === 'string' && IS_ISSUE_ID.test(v)) ref(st, v, v === i.parentId ? 2 : w);
        if (typeof i.project === 'string') bump(st.projects, i.project, 3);
        if (b.name.endsWith('_project') && typeof i.query === 'string') bump(st.projects, i.query, 3);
      }
    }
  }
}

// Reads only the bytes appended since the last scan.
async function scanLinear(sid) {
  const t = transcripts.get(sid);
  if (!t) return;
  let st = linearScans.get(sid);
  const fresh = () => ({ offset: 0, carry: '', pending: new Map(), prCreates: new Set(), refs: new Map(), projects: new Map(), prs: new Map(), refsAt: new Map(), story: { asks: [], recaps: [], compacts: [] } });
  if (!st) linearScans.set(sid, (st = fresh()));
  if (t.size < st.offset) Object.assign(st, fresh()); // rewritten
  if (t.size === st.offset) return;
  const end = t.size;
  const stream = fs.createReadStream(t.file, { start: st.offset, end: end - 1, encoding: 'utf8' });
  for await (const chunk of stream) {
    const lines = (st.carry + chunk).split('\n');
    st.carry = lines.pop();
    for (const line of lines) linearLine(line, st);
  }
  st.offset = end;
}

let linearBusy = false;
async function linearTick() {
  if (linearBusy) return;
  linearBusy = true;
  try { for (const s of state.sessions) await scanLinear(s.sessionId); }
  catch (e) { console.error('linear scan failed', e); }
  finally { linearBusy = false; }
}

// Strongest signals first: the git branch / worktree, then the title, then
// Linear tool calls, then ids the user typed. Only confirmed team keys count,
// so strings like UTF-8 or SHA-256 never become tickets.
function linearFor(sid, { title, branch, worktree }) {
  const st = linearScans.get(sid);
  const score = new Map(st?.refs);
  const onBranch = new Set();
  for (const [, p, n] of `${branch || ''} ${worktree || ''}`.toUpperCase().matchAll(ISSUE_ID)) { bump(score, `${p}-${n}`, 100); onBranch.add(`${p}-${n}`); }
  for (const [, p, n] of (title || '').matchAll(ISSUE_ID)) bump(score, `${p}-${n}`, 50);
  // The ten most relevant tickets, newest first: the branch's ticket is the
  // current task, then the one the session touched last.
  const lastAt = (id) => (onBranch.has(id) ? Infinity : st?.refsAt.get(id) || 0);
  const tickets = [...score]
    .filter(([id, n]) => n >= 3 && teamKeys.has(id.split('-')[0]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .sort((a, b) => lastAt(b[0]) - lastAt(a[0]) || b[1] - a[1])
    .map(([id]) => ({ ...(catalog.get(id) || { id }), lastAt: st?.refsAt.get(id), onBranch: onBranch.has(id) || undefined }));
  const proj = new Map(st?.projects);
  tickets.forEach((t, i) => { if (t.project) bump(proj, t.project, 10 - i); });
  const projects = [...proj].filter(([name]) => projectNames.has(name)).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([name]) => projectInfo.get(name) || { name });
  return tickets.length || projects.length ? { tickets, projects } : undefined;
}

// ---------- pull requests (read-only GitHub lookups via the gh CLI) ----------

const prState = new Map(); // "owner/repo#n" -> { state, isDraft, review, checks, title, url, fetchedAt }

function prsFor(sid) {
  const st = linearScans.get(sid);
  if (!st) return [];
  return [...st.prs].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => {
    const [repo, n] = key.split('#');
    return { key, repo, number: Number(n), url: `https://github.com/${repo}/pull/${n}`, ...prState.get(key) };
  });
}

let prBusy = false;
async function prTick() {
  if (prBusy) return;
  prBusy = true;
  try {
    const now = Date.now();
    const due = new Set();
    for (const s of state.sessions) for (const p of prsFor(s.sessionId)) {
      const known = prState.get(p.key);
      const maxAge = !known ? 0 : known.state === 'OPEN' ? 90e3 : 30 * 60e3; // merged/closed rarely change
      if (!known || now - known.fetchedAt > maxAge) due.add(p.key);
    }
    const keys = [...due];
    for (let i = 0; i < keys.length; i += 40) {
      const chunk = keys.slice(i, i + 40);
      const q = chunk.map((key, j) => {
        const [repo, n] = key.split('#');
        const [owner, name] = repo.split('/');
        return `p${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(n)}) {
          state isDraft reviewDecision title url mergedAt commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
      }).join('\n');
      const r = await run('gh', ['api', 'graphql', '-f', `query={ ${q} }`]);
      let data = {};
      // gh exits non-zero when any PR in the batch is missing, but stdout still has the rest.
      try { data = JSON.parse(r.stdout).data || {}; } catch { /* network or auth error, retry next tick */ }
      chunk.forEach((key, j) => {
        const pr = data[`p${j}`]?.pullRequest;
        if (pr) prState.set(key, {
          state: pr.state, isDraft: pr.isDraft, review: pr.reviewDecision, title: pr.title, url: pr.url, mergedAt: pr.mergedAt,
          checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state, fetchedAt: now,
        });
        else if (data && Object.keys(data).length) prState.set(key, { state: 'UNKNOWN', fetchedAt: now }); // no access or deleted
      });
    }
  } catch (e) { console.error('pr lookup failed', e); }
  finally { prBusy = false; }
}

// ---------- session story ----------

const SUMMARY_FILE = path.join(DATA_DIR, 'stories.json');
let written = {};
try { written = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')); } catch { /* none yet */ }
const firstSentence = (t) => (t.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] || t).trim();

function storyFor(sid, s) {
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

// A readable paragraph without a model: the opening request, the first
// sentence of a spread of turn recaps, and where it stands now.
function stitch(story, s) {
  const first = story.asks[0]?.text;
  const recaps = story.recaps.map((r) => r.text);
  if (!first && !recaps.length) return s?.lastAssistant ? `Latest: ${s.lastAssistant}` : '';
  const parts = [];
  if (first) parts.push(`It started with: “${clip(first, 220)}”`);
  if (recaps.length > 1) {
    const middle = recaps.slice(0, -1);
    const pick = middle.length <= 6 ? middle : Array.from({ length: 6 }, (_, i) => middle[Math.round((i * (middle.length - 1)) / 5)]);
    const seen = new Set();
    const steps = pick.map(firstSentence).filter((x) => x && !seen.has(x) && seen.add(x));
    if (steps.length) parts.push(`Along the way: ${steps.join(' ')}`);
  }
  if (recaps.length) parts.push(`Now: ${recaps.at(-1)}`);
  else if (s?.lastAssistant) parts.push(`Latest: ${s.lastAssistant}`);
  return parts.join(' ');
}

// One paragraph written by Claude (Haiku) from the session's digest. Needs the
// terminal CLI to be logged in. Runs without tools, settings or saved history.
const writing = new Set();
function sessionDigest(s, st) {
  const { asks, recaps, compacts } = st.story;
  return [
    `Session title: ${s.title}`,
    `Folder: ${s.cwd}${s.branch ? ` (branch ${s.branch})` : ''}`,
    s.linear?.tickets?.length ? `Linear tickets: ${s.linear.tickets.map((t) => `${t.id}${t.title ? ` "${t.title}"` : ''}${t.status ? ` [${t.status}]` : ''}`).join(', ')}` : '',
    s.prs?.length ? `Pull requests: ${s.prs.map((p) => `${p.repo}#${p.number}${p.state ? ` [${p.state}${p.review ? `, ${p.review}` : ''}]` : ''}`).join(', ')}` : '',
    compacts.length ? `Earlier context (compaction summary):\n${clip(compacts.at(-1).text, 3000)}` : '',
    `What the user asked, in order:\n${asks.slice(0, 40).map((a, i) => `${i + 1}. ${clip(a.text, 300)}`).join('\n')}`,
    recaps.length ? `End-of-turn recaps, in order:\n${recaps.slice(-60).map((r, i) => `${i + 1}. ${r.text}`).join('\n')}` : `Latest reply: ${s.lastAssistant || ''}`,
  ].filter(Boolean).join('\n\n');
}

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

async function writeSummary(sid) {
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
    await fsp.writeFile(SUMMARY_FILE, JSON.stringify(written));
    return { ok: true, out: 'Summary written.' };
  } finally { writing.delete(sid); }
}

// ---------- what is still open ----------

// Words that mark unfinished business in a recap sentence.
const OPEN_CUE = /\b(blocked|block(s|ing)|wait(s|ing)? (on|for)|awaiting|still (to|needs?|open|running|pending)|not (yet|verified|tested|checked|run|committed|pushed|merged|deployed|released|done)|isn't|aren't|hasn't|haven't|needs?\b|pending|remaining|left to|to do|todo|follow-?up|next step|open question|unverified|until|owed|depends on|requires?|must|has to|have to)\b/i;
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(#])/).map((x) => x.trim()).filter(Boolean);

// A first pass with no model: the open-sounding sentences of the last two
// recaps, unfinished Linear tickets and PRs that still need something.
function openItemsFor(s, st) {
  const items = [];
  const seen = new Set();
  const add = (kind, text, extra = {}) => { const k = text.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push({ kind, text, ...extra }); } };
  for (const r of (st?.story.recaps || []).slice(-2).reverse())
    for (const x of sentencesOf(r.text)) if (OPEN_CUE.test(x) && !/^(nothing|no action|all done)\b/i.test(x)) add('note', x);
  for (const p of s.prs || []) if (p.state === 'OPEN')
    add('pr', `PR #${p.number} is open${p.isDraft ? ' as a draft' : ''}${p.review === 'REVIEW_REQUIRED' ? ' and needs a review' : p.review === 'CHANGES_REQUESTED' ? ' with changes requested' : p.review === 'APPROVED' ? ', approved and ready to merge' : ''}${p.checks === 'FAILURE' ? '; checks are failing' : ''}.`,
      { url: p.url, number: p.number, title: p.title, review: p.review, checks: p.checks, isDraft: p.isDraft, prState: p.state });
  for (const t of (s.linear?.tickets || []).slice(0, 4))
    if (t.status && !['completed', 'canceled'].includes(t.statusType) && !/^(done|duplicate|canceled|cancelled)$/i.test(t.status))
      add('ticket', `${t.id} is ${t.status}${t.title ? `: ${t.title}` : ''}.`, { url: t.url, id: t.id, title: t.title, status: t.status, statusType: t.statusType });
  return items.slice(0, 8);
}

// The one line a waiting card shows: the strongest reason this session is still
// alive, in its own voice. Strongest first: a question, a PR that needs someone, a
// blocker, unshipped or unverified work, a ticket still in progress.
function aliveReason(s, items) {
  const ask = s.story?.waitingOn?.ask;
  if (ask) return { tone: 'ask', text: `Waiting for your answer: “${clip(ask, 110)}”` };
  for (const p of s.prs || []) if (p.state === 'OPEN') {
    if (p.review === 'CHANGES_REQUESTED') return { tone: 'block', text: `PR #${p.number} has changes requested. I need you.` };
    if (p.checks === 'FAILURE' || p.checks === 'ERROR') return { tone: 'block', text: `PR #${p.number} has failing checks. Don't forget me.` };
  }
  for (const p of s.prs || []) if (p.state === 'OPEN' && !p.isDraft)
    return p.review === 'APPROVED'
      ? { tone: 'ship', text: `PR #${p.number} is approved. Merge me.` }
      : { tone: 'wip', text: `PR #${p.number} is waiting for review. Don't archive me.` };
  const notes = items.filter((i) => i.kind === 'note').map((i) => i.text);
  const blocked = notes.find((n) => /\bblock(ed|s|ing)\b|waits? (on|for)|awaiting|depends on/i.test(n));
  if (blocked) return { tone: 'block', text: `Blocked: ${clip(blocked, 120)}` };
  const unshipped = notes.find((n) => /\b(deploy|release|beta|prod|live|publish|ship)/i.test(n));
  if (unshipped) return { tone: 'ship', text: `Not shipped yet: ${clip(unshipped, 120)}` };
  const unverified = notes.find((n) => /not (yet )?(verified|tested|checked|run|tried)|hasn't been (tried|tested|run)|unverified|still running/i.test(n));
  if (unverified) return { tone: 'wip', text: `Not verified yet: ${clip(unverified, 120)}` };
  const started = (s.linear?.tickets || []).find((t) => t.statusType === 'started' || /progress|review/i.test(t.status || ''));
  if (started) return { tone: 'wip', text: `${started.id} is still ${started.status}. Don't archive me.` };
  if (notes.length) return { tone: 'wip', text: clip(notes[0], 130) };
  const todo = (s.linear?.tickets || []).find((t) => t.status && !['completed', 'canceled'].includes(t.statusType) && !/^(done|duplicate|canceled|cancelled)$/i.test(t.status));
  if (todo) return { tone: 'wip', text: `${todo.id} is ${todo.status}. Someone has to pick it up.` };
  return { tone: 'done', text: 'Nothing open that I can see. Safe to archive.' };
}

// ---------- deployments ----------
// Which repositories a session is shipping, at which version, and how far they got,
// read from its turn recaps ("web-app 1.8.25 is on beta", "…still waits at the
// production gate"). A bare version joins the repository last named on its major.minor.

const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
// t is one sentence; versions like 6.28.25 contain dots, so patterns span the whole sentence (.*), not [^.]*.
function deployStage(t) {
  if (/production gates?|prod(uction)? gates?|\bwait(s|ing)?\b.*\b(gates?|production|prod)\b|\bproduction\b.*\b(wait(s|ing)?|pending|unapproved|not approved)\b/i.test(t)) return 'gate';
  if (/\b(not|isn't|aren't|hasn't|never)\b.*\b(in|on|to) (production|prod)\b/i.test(t)) return undefined;
  if (/\b(live|deployed|released|running|shipped|rolled out)\b.*\b(in|on|to) (production|prod)\b|\b(in|on) production\b/i.test(t)) return 'prod';
  if (/\b(not|isn't|aren't)\b (yet )?on beta\b|beta still runs|\bnot (yet )?deployed\b/i.test(t)) return 'tagged';
  if (/\bon (beta|staging|preprod)\b|\b(beta|staging)\b.*\b(succeed|deployed|runs|live)\b|\bdeploy(ed)? .*\bto (beta|staging)\b/i.test(t)) return 'beta';
  if (/not cut|not tagged|\b(tag|release)\b.*\bready\b|\bready to (tag|release|ship|deploy)\b/i.test(t)) return 'ready';
  if (/live on github|\b(tag|release)\b.*\b(live|cut|published|pushed|created)\b|\btagged\b/i.test(t)) return 'tagged';
  return undefined;
}
const DEPLOY_LABEL = { prod: 'In production', gate: 'Waiting at the production gate', beta: 'On beta, not in production', tagged: 'Tagged, not on beta yet', ready: 'Ready, not tagged yet' };

function deploysFor(st) {
  const repos = new Map();
  const family = new Map(); // "6.28" -> repository last named with that line
  for (const r of st?.story.recaps || []) for (const sent of sentencesOf(r.text)) {
    const found = [];
    for (const m of sent.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
      const fam = m[1].split('.').slice(0, 2).join('.');
      const named = sent.slice(Math.max(0, m.index - 40), m.index).match(/\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|shell)\s+(?:v)?$/i)?.[1]?.toLowerCase();
      const repo = named || family.get(fam);
      if (named) family.set(fam, named);
      if (repo) found.push([repo, m[1]]);
    }
    const stage = found.length ? deployStage(sent) : undefined;
    if (!stage) continue; // a version with no deploy wording (a benchmark, a mock) isn't a deployment
    for (const [repo, version] of found) {
      const cur = repos.get(repo);
      if (cur && cmpVer(version, cur.version) < 0) continue; // an older version mentioned later
      repos.set(repo, { repo, version, stage, label: DEPLOY_LABEL[stage], evidence: clip(sent, 220), ts: r.ts });
    }
  }
  const order = { gate: 0, beta: 1, tagged: 2, ready: 3, prod: 4 };
  return [...repos.values()].sort((a, b) => order[a.stage] - order[b.stage] || a.repo.localeCompare(b.repo));
}

const CHECK_FILE = path.join(DATA_DIR, 'open-items.json');
let checks = {};
try { checks = JSON.parse(fs.readFileSync(CHECK_FILE, 'utf8')); } catch { /* none yet */ }
const checking = new Set();

// Claude reads the whole digest and lists what is still open, each with a reply the user could send.
async function checkOpen(sid) {
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
    await fsp.writeFile(CHECK_FILE, JSON.stringify(checks));
    return { ok: true, out: 'Checked.' };
  } finally { checking.delete(sid); }
}

// ---------- usage ----------

// Written by statusline.mjs whenever a terminal Claude Code session redraws its status line.
const USAGE_FILE = path.join(DATA_DIR, 'usage-statusline.json');
const APP_USAGE_FILE = path.join(APP_DIR, 'plan-usage-history.json');
// The Claude app's usage card, saved by a Claude session's get_usage call
// (see README): { plan, windows: [{ label, percentUsed, resetsAt }], updatedAt }.
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');

// Every source becomes { plan, windows: [{ label, used, resetsAt (ms) }], updatedAt, source }; the newest wins.
async function readPlanLimits() {
  const sources = [];
  try {
    const p = JSON.parse(await fsp.readFile(PLAN_FILE, 'utf8'));
    if (Array.isArray(p.windows)) sources.push({
      plan: p.plan, updatedAt: p.updatedAt, source: 'app',
      windows: p.windows.map((w) => ({ label: w.label, used: w.percentUsed, resetsAt: Date.parse(w.resetsAt) || undefined })),
    });
  } catch { /* not saved yet */ }
  try {
    const l = JSON.parse(await fsp.readFile(USAGE_FILE, 'utf8'));
    const win = (w, label) => w && typeof w.used_percentage === 'number' && { label, used: w.used_percentage, resetsAt: w.resets_at ? w.resets_at * 1000 : undefined };
    sources.push({ updatedAt: l.updatedAt, source: 'statusline', windows: [win(l.five_hour, '5-hour limit'), win(l.seven_day, 'Weekly · all models')].filter(Boolean) });
  } catch { /* not written yet */ }
  try {
    const last = JSON.parse(await fsp.readFile(APP_USAGE_FILE, 'utf8')).samples?.at(-1);
    if (last && Date.now() - last.t < 6 * 3600e3)
      sources.push({ updatedAt: last.t, source: 'app-history', windows: [{ label: '5-hour limit', used: last.u.fh }, { label: 'Weekly · all models', used: last.u.sd }] });
  } catch { /* app never sampled */ }
  return sources.filter((x) => x.windows.length).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

let state = { sessions: [], at: 0 };
let uiVersion = '';
let stateJson = '';
const cwdCache = new Map(); // sid -> cwd for ended sessions

async function cwdForEnded(sid, file) {
  if (cwdCache.has(sid)) return cwdCache.get(sid);
  let cwd = '';
  try {
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const m = buf.toString('utf8', 0, bytesRead).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) cwd = JSON.parse(`"${m[1]}"`);
  } catch { /* ignore */ }
  cwd ||= cwdFromTranscriptDir(file);
  cwdCache.set(sid, cwd);
  return cwd;
}

// Oldest ended session to keep: covers the widest UI range ("This month", or
// "This week" when the week started in the previous month).
function historyCutoff() {
  if (RECENT_HOURS) return Date.now() - RECENT_HOURS * 3600e3;
  const d = new Date();
  const day = (offset) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return Math.min(monthStart, day((d.getDay() + 6) % 7), day(2));
}

// ---------- Claude desktop app metadata (read only) ----------
// The app keeps one JSON per Code-tab session: its local_ id, archived flag and
// the session it was spawned from. Never written to: the app owns these files.

const APP_SESSIONS_DIR = path.join(APP_DIR, 'claude-code-sessions');
const appMeta = new Map(); // cli sessionId -> { appId, parentAppId, archived, summary }
const appIdToCli = new Map();
const appFileMtimes = new Map();
const appFiles = new Map(); // app session id -> its metadata file

async function scanAppMeta() {
  const files = [];
  try {
    for (const a of await fsp.readdir(APP_SESSIONS_DIR))
      for (const o of await fsp.readdir(path.join(APP_SESSIONS_DIR, a)).catch(() => []))
        for (const f of await fsp.readdir(path.join(APP_SESSIONS_DIR, a, o)).catch(() => []))
          if (/^local_.*\.json$/.test(f)) files.push(path.join(APP_SESSIONS_DIR, a, o, f));
  } catch { return; }
  await Promise.all(files.map(async (file) => {
    try {
      const st = await fsp.stat(file);
      if (appFileMtimes.get(file) === st.mtimeMs) return;
      appFileMtimes.set(file, st.mtimeMs);
      const m = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!m.cliSessionId || !m.sessionId) return;
      appIdToCli.set(m.sessionId, m.cliSessionId);
      appFiles.set(m.sessionId, file);
      appMeta.set(m.cliSessionId, {
        appId: m.sessionId, parentAppId: m.spawnedFrom?.sessionId, archived: !!m.isArchived,
        summary: m.postTurnSummary?.status_detail, needsAction: m.postTurnSummary?.needs_action || undefined,
        scheduledTaskId: m.scheduledTaskId, lastFocusedAt: m.lastFocusedAt || 0,
      });
    } catch { /* mid-write; next scan */ }
  }));
}

// Sessions hidden from the console. App sessions can only be archived inside the app.
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');
let consoleArchive = new Set();
try { consoleArchive = new Set(JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'))); } catch { /* none yet */ }
const saveArchive = () => fsp.writeFile(ARCHIVE_FILE, JSON.stringify([...consoleArchive]));

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

const clients = new Set();
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
}
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sessions = await buildState();
    const usage = { plan: await readPlanLimits() };
    try { uiVersion = String((await fsp.stat(path.join(HERE, 'public', 'index.html'))).mtimeMs); } catch { /* keep */ }
    const json = JSON.stringify({ sessions, usage, uiVersion });
    if (json !== stateJson) {
      stateJson = json;
      state = { sessions, usage, uiVersion, at: Date.now() };
      for (const c of clients) send(c, 'state', state);
    }
  } catch (e) { console.error('tick failed', e); }
  finally { ticking = false; }
}

await scanTranscripts();
await scanAppMeta();
await tick();
setInterval(scanAppMeta, 4000);
setInterval(tick, 1000);
linearTick().then(prTick);
setInterval(linearTick, 3000);
setInterval(prTick, 30000);
setInterval(scanTranscripts, 15000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);
try { fs.watch(SESS_DIR, () => tick()); } catch { /* polling covers it */ }

// Per-session transcript stream: backlog, then appended events as they land.
function streamSession(req, res, sid) {
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

// ---------- actions ----------

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const osa = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, out: (stdout + stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() }));
  });
}

function openTerminal(cwd, command) {
  const script = `tell application "Terminal"\n activate\n do script "cd ${osa(sh(cwd))} && ${osa(command)}"\nend tell`;
  return run('osascript', ['-e', script]);
}

const find = (sid) => state.sessions.find((s) => s.sessionId === sid);

async function act(name, body) {
  const s = body.sessionId ? find(body.sessionId) : undefined;
  if (body.sessionId && !s) return { ok: false, out: 'Session not found (it may have been cleaned up).' };
  switch (name) {
    case 'refresh-usage': {
      // Nothing outside the app can run its scheduled task, so a stale reading opens
      // the task in the Claude app, where "Run now" takes one click.
      await tick();
      const plan = state.usage?.plan;
      if (plan && Date.now() - plan.updatedAt < 2 * 60e3) return { ok: true, out: 'Usage is up to date.' };
      await run('open', [`claude://claude.ai/epitaxy/scheduled/${USAGE_TASK_ID}`]);
      return { ok: true, opened: true, out: 'Opened the usage task in the Claude app. Click Run now there; the toolbar updates by itself when it finishes.' };
    }
    case 'open-ax-settings':
      return run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
    case 'automation-status':
      return automationStatus();
    case 'send-app':
      return sendToApp(s, String(body.text || '').trim());
    case 'open-app':
      // The app's own deep link for one Code session: it focuses exactly that session.
      if (s?.appId) return run('open', [`claude://claude.ai/epitaxy/${s.appId}`]);
      return run('open', ['-a', 'Claude']);
    case 'archive': {
      if (s.kind === 'background') {
        if (s.running) await run(CLAUDE_BIN, ['stop', s.jobId]);
        const r = await run(CLAUDE_BIN, ['rm', s.jobId]);
        if (!r.ok) return r;
      }
      consoleArchive.add(s.sessionId);
      await saveArchive();
      return { ok: true, out: s.appId ? 'Archived in the console. To archive it in the Claude app too, use the app.' : 'Archived.' };
    }
    case 'check-open':
      return checkOpen(s.sessionId);
    case 'summarize':
      return writeSummary(s.sessionId);
    case 'unarchive':
      if (s.appArchived && !consoleArchive.has(s.sessionId)) return { ok: false, out: 'This one was archived in the Claude app. Unarchive it there.' };
      consoleArchive.delete(s.sessionId);
      await saveArchive();
      return { ok: true, out: 'Back on the board.' };
    case 'terminal':
      if (s.kind === 'background' && s.running) return openTerminal(s.cwd, `${CLAUDE_BIN} attach ${s.jobId}`);
      if (s.running) return { ok: false, out: 'This session is already open elsewhere. Resuming it here would start a copy.' };
      return openTerminal(s.cwd, `${CLAUDE_BIN} --resume ${s.sessionId}`);
    case 'stop':
      if (s.kind !== 'background') return { ok: false, out: 'Only background agents can be stopped from here.' };
      return run(CLAUDE_BIN, ['stop', s.jobId]);
    case 'remove':
      if (s.kind !== 'background') return { ok: false, out: 'Only background agents can be removed from here.' };
      return run(CLAUDE_BIN, ['rm', s.jobId]);
    case 'continue': {
      const text = String(body.text || '').trim();
      if (!text) return { ok: false, out: 'Write a message first.' };
      if (s.running) return { ok: false, out: 'This session is running. Attach to it (background) or use the Claude app.' };
      return run(CLAUDE_BIN, ['--bg', '--resume', s.sessionId, text], { cwd: s.cwd });
    }
    case 'project-updates': {
      // A new Claude app session with the skill's command typed in; Claude writes, you confirm, then it posts.
      const range = ['today', 'yesterday', 'week'].includes(body.range) ? body.range : 'today';
      const prompt = range === 'today' ? '/project-updates' : `/project-updates ${range}`;
      const r = await run('open', [`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(os.homedir())}`]);
      return r.ok ? { ok: true, out: 'A Claude app session is open with /project-updates typed in. Press Enter there; it shows the drafts and posts nothing until you say yes.' } : r;
    }
    case 'new-in-app': {
      // The Claude app's own link for a new Code session, with the prompt typed in and the folder chosen.
      const prompt = String(body.prompt || '').trim();
      const cwd = String(body.cwd || '').trim();
      if (!prompt || !cwd) return { ok: false, out: 'Folder and prompt are required.' };
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, out: `No such folder: ${cwd}` };
      if (prompt.length > 14000) return { ok: false, out: 'The prompt is too long for the Claude app link (14,000 characters at most).' };
      const files = (Array.isArray(body.files) ? body.files : []).map(attachmentPath).filter((f) => f && fs.existsSync(f)).slice(0, 10);
      const fileParams = files.map((f) => `&file=${encodeURIComponent(f)}`).join('');
      const r = await run('open', [`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(cwd)}${fileParams}`]);
      return r.ok ? { ok: true, out: 'A new Claude app session is open with your prompt typed in. Press Enter there to start it.' } : r;
    }
    case 'dispatch': {
      const prompt = String(body.prompt || '').trim();
      const cwd = String(body.cwd || '').trim();
      if (!prompt || !cwd) return { ok: false, out: 'Folder and prompt are required.' };
      if (!fs.existsSync(cwd)) return { ok: false, out: `No such folder: ${cwd}` };
      const args = ['--bg'];
      if (body.model) args.push('--model', String(body.model));
      if (body.permissionMode) args.push('--permission-mode', String(body.permissionMode));
      args.push(prompt);
      return run(CLAUDE_BIN, args, { cwd });
    }
    default:
      return { ok: false, out: `Unknown action ${name}` };
  }
}

// ---------- http ----------

// Images pasted or dropped into the editor, saved where Claude Code can open them by path.
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const attachmentPath = (name) => (/^[\w.-]+$/.test(name) ? path.join(ATTACH_DIR, name) : undefined);
async function saveAttachment(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return { ok: false, out: 'Only PNG, JPEG, GIF or WebP images can be attached.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return { ok: false, out: 'Images up to 10 MB only.' };
  await fsp.mkdir(ATTACH_DIR, { recursive: true });
  const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}.${IMAGE_TYPES[m[1]]}`;
  await fsp.writeFile(path.join(ATTACH_DIR, name), buf);
  return { ok: true, name, path: path.join(ATTACH_DIR, name), url: `/api/attachments/${name}` };
}

// ---------- send to a Claude app session (opt-in, macOS automation) ----------
// The app has no input API, so this does what you would do: open the session,
// paste, press Enter. Every step is checked; on any doubt it stops before Enter.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pipeTo(cmd, input) {
  return new Promise((resolve) => {
    const c = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (b) => { o += b; });
    c.on('error', () => resolve({ ok: false, out: '' }));
    c.on('close', (code) => resolve({ ok: code === 0, out: o }));
    c.stdin.end(input ?? '');
  });
}
const runOsa = (script, ...args) => new Promise((resolve) => {
  execFile('osascript', ['-e', script, ...args], { timeout: 60000 }, (err, stdout, stderr) => // the box search can take ~25s
    resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() }));
});
const frontApp = async () => (await runOsa('tell application "System Events" to get name of first application process whose frontmost is true')).out;

// Accessibility (to read the focused box and press keys) and Automation (to talk to System Events).
async function automationStatus() {
  if (process.platform !== 'darwin') return { ok: false, out: 'Send to agent needs macOS.' };
  // "UI elements enabled" is macOS's own answer to "may this process use Accessibility?".
  const r = await runOsa('tell application "System Events" to return (UI elements enabled as text) & "," & ((exists process "Claude") as text)');
  const node = process.execPath;
  if (!r.ok) {
    const why = /-1743|not allowed to send apple events|Not authorized/i.test(r.err) ? 'automation' : 'unknown';
    return { ok: false, why, node, out: r.err || 'Not allowed yet.' };
  }
  const [ax, running] = r.out.split(',');
  if (ax !== 'true') return { ok: false, why: 'accessibility', node, out: 'Accessibility is not allowed for node yet.' };
  if (running !== 'true') return { ok: false, why: 'app-closed', node, out: 'The Claude app is not running.' };
  return { ok: true, node, out: 'Automation is allowed.' };
}

// The Claude app shows its message box to accessibility only inside its own process, so the console
// can't read the box. It types the way you would and then confirms the result in the session's transcript.
const PASTE_AND_ENTER = `on run
  tell application "System Events"
    if (name of (first application process whose frontmost is true)) is not "Claude" then return "not-front"
    keystroke "v" using command down
  end tell
  delay 0.4
  tell application "System Events"
    if (name of (first application process whose frontmost is true)) is not "Claude" then return "not-front-after"
    key code 36
  end tell
  return "typed"
end run`;

// Waits for a new user message containing the reply in the session's transcript.
async function seenInTranscript(sid, fromSize, probe, ms = 8000) {
  const t = transcripts.get(sid);
  if (!t) return false;
  const want = probe.toLowerCase();
  for (const end = Date.now() + ms; Date.now() < end;) {
    await sleep(400);
    try {
      const st = await fsp.stat(t.file);
      if (st.size <= fromSize) continue;
      const fh = await fsp.open(t.file, 'r');
      const buf = Buffer.alloc(st.size - fromSize);
      await fh.read(buf, 0, buf.length, fromSize);
      await fh.close();
      for (const line of buf.toString('utf8').split('\n')) {
        const queued = line.includes('"type":"queue-operation"');
        if (!queued && !line.includes('"type":"user"')) continue;
        try {
          const d = JSON.parse(line);
          const c = queued ? (d.operation === 'enqueue' ? d.content : '') : d.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
          if (text.replace(/\s+/g, ' ').toLowerCase().includes(want)) return queued ? 'queued' : 'sent';
        } catch { /* partial line */ }
      }
    } catch { /* transient */ }
  }
  return false;
}

const SEND_REASONS = {
  'not-front': 'The Claude app was not in front.',
  'not-front-after': 'Another app came to the front while pasting.',
  'not-pasted': 'The pasted text could not be confirmed in the message box, so Enter was not pressed. Check it in the app and press Enter yourself.',

  'not-focused': "The app didn't switch to that session in time.",
};

// One log line per send: steps and macOS answers only, never the text.
const sendLog = (appId, msg) => console.log(`[send-to-agent] ${new Date().toISOString()} ${appId}: ${msg}`);

async function sendToApp(s, text) {
  if (!s.appId) return { ok: false, out: 'This is not a Claude app session.' };
  if (!text || text.length > 20000) return { ok: false, out: 'Write something (up to 20,000 characters).' };
  const status = await automationStatus();
  if (!status.ok) { sendLog(s.appId, `not allowed: ${status.why} ${status.out}`); return { ...status, ok: false, out: `Send to agent isn't allowed yet (${status.why}). Your reply was not sent.` }; }
  const before = await pipeTo('pbpaste');
  await pipeTo('pbcopy', text);
  const t0 = Date.now();
  await run('open', [`claude://claude.ai/epitaxy/${s.appId}`]);
  // Wait until the app itself reports this exact session focused, with the app in front: either it
  // was focused just now, or it already was the most recently focused session (re-opening it changes nothing).
  const othersFocusedAt = Math.max(0, ...[...appMeta.values()].filter((x) => x.appId !== s.appId).map((x) => x.lastFocusedAt || 0));
  let focused = false;
  for (let i = 0; i < 30 && !focused; i++) {
    await sleep(200);
    try {
      const at = JSON.parse(await fsp.readFile(appFiles.get(s.appId), 'utf8')).lastFocusedAt || 0;
      focused = (at >= t0 - 1000 || at > othersFocusedAt) && (await frontApp()) === 'Claude';
    } catch { /* file mid-write */ }
  }
  if (!focused) {
    let at = 0; try { at = JSON.parse(await fsp.readFile(appFiles.get(s.appId), 'utf8')).lastFocusedAt || 0; } catch { /* */ }
    sendLog(s.appId, `not focused: front=${await frontApp()} lastFocusedAt=${at} t0=${t0} othersMax=${othersFocusedAt} file=${appFiles.has(s.appId)}`);
    return { ok: false, out: `${SEND_REASONS['not-focused']} Your reply is on the clipboard: paste it there.` };
  }
  await sleep(600); // let the composer take focus after the switch
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  await refreshTranscript(s.sessionId);
  const fromSize = transcripts.get(s.sessionId)?.size || 0;
  const r = await runOsa(PASTE_AND_ENTER);
  sendLog(s.appId, `typed: out=${r.out || '-'} err=${r.err || '-'}`);
  if (r.out !== 'typed') return { ok: false, out: `Not sent: ${SEND_REASONS[r.out] || r.err || r.out} Your reply is on the clipboard.` };
  const seen = await seenInTranscript(s.sessionId, fromSize, probe.toLowerCase());
  sendLog(s.appId, `confirmed in transcript: ${seen}`);
  if (seen) {
    setTimeout(() => { if (before.ok) pipeTo('pbcopy', before.out); }, 1500); // give your clipboard back
    return { ok: true, out: seen === 'queued' ? 'Sent ✓ The session is busy, so it is queued and runs next.' : 'Sent ✓ It arrived in the session.' };
  }
  return { ok: false, out: "Pasted and pressed Enter, but the reply didn't show up in the session within 8 seconds. Check the Claude app; your reply is still on the clipboard." };
}

// ---------- daily digest for project updates ----------
// Everything the project-updates skill needs for one day, grouped by Linear project.
// Sessions with no Linear project are listed apart and left out of the updates.

function dayRange(range) {
  const d = new Date();
  const day = (back) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  if (range === 'yesterday') return { from: day(1), to: day(0), label: 'yesterday' };
  if (range === 'week') return { from: day((d.getDay() + 6) % 7), to: Infinity, label: 'this week' };
  return { from: day(0), to: Infinity, label: 'today' };
}

function digest(range) {
  const { from, to, label } = dayRange(range);
  const inDay = (ts) => ts >= from && ts < to;
  const projects = new Map();
  const unassigned = [];
  for (const s of state.sessions) {
    if (!inDay(s.lastTs || 0)) continue;
    const st = linearScans.get(s.sessionId);
    const recaps = (st?.story.recaps || []).filter((r) => inDay(r.ts)).map((r) => r.text);
    const asks = (st?.story.asks || []).filter((a) => inDay(a.ts)).map((a) => a.text);
    if (!recaps.length && !asks.length) continue; // nothing a person did that day
    const entry = {
      title: s.title, phase: s.phase,
      story: s.story?.written?.text || s.story?.stitched || '',
      recapsThatDay: recaps.slice(-12), asksThatDay: asks.slice(-8),
      stillOpen: (s.openItems || []).map((i) => i.text).slice(0, 6),
      tickets: (s.linear?.tickets || []).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      pullRequests: (s.prs || []).filter((p) => p.state).map((p) => ({ repo: p.repo, number: p.number, title: p.title, state: p.state, mergedAt: p.mergedAt })),
      deployments: (s.deploys || []).map((x) => ({ repo: x.repo, version: x.version, stage: x.label })),
    };
    const project = s.linear?.projects?.[0];
    if (!project) { unassigned.push(s.title); continue; }
    if (!projects.has(project.name)) projects.set(project.name, { name: project.name, url: project.url, sessions: [] });
    projects.get(project.name).sessions.push(entry);
  }
  return { range: label, from: new Date(from).toISOString(), generatedAt: new Date().toISOString(), projects: [...projects.values()], unassigned };
}

// ---------- avatar (optional) ----------
// A talking face that reads replies aloud, all local: a mouth bank built once by avatar/bank_build.py
// and Kokoro speech from avatar/tts_worker.py. Off unless the bank exists.

const AVATAR_DIR = process.env.CCMC_AVATAR_DIR || path.join(os.homedir(), '.local', 'share', 'presenter-film', 'avatar', 'clara');
const KOKORO_PY = process.env.CCMC_KOKORO_PYTHON || path.join(os.homedir(), '.local', 'share', 'presenter-film', 'venvs', 'kokoro', 'bin', 'python');
const TTS_DIR = path.join(os.tmpdir(), 'cc-mission-control-tts');
let tts = null;

function ttsWorker() {
  if (tts) return tts;
  fs.mkdirSync(TTS_DIR, { recursive: true });
  const child = spawn(KOKORO_PY, ['-I', path.join(HERE, 'avatar', 'tts_worker.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buf = '';
  let ready;
  const w = { child, waiting, next: 1, alive: true, ready: new Promise((r) => { ready = r; }) };
  tts = w;
  // A worker that never says it is ready (stuck import, model fetch) is killed, so requests fail instead of hanging.
  const startup = setTimeout(() => child.kill(), 120000);
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { clearTimeout(startup); ready(); }
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const fail = () => {
    clearTimeout(startup);
    w.alive = false;
    for (const r of waiting.values()) r({ ok: false, error: 'the voice stopped' });
    waiting.clear();
    if (tts === w) tts = null;
    ready();
  };
  child.on('exit', fail);
  child.on('error', fail);
  child.stdin.on('error', () => { /* a dead worker's pipe: 'exit' reports it */ });
  return w;
}

async function speakToFile(text, voice) {
  const key = crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex').slice(0, 20);
  const out = path.join(TTS_DIR, `${key}.wav`);
  if (fs.existsSync(out)) return { ok: true, out };
  const w = ttsWorker();
  await w.ready;
  if (!w.alive) return { ok: false, error: 'the voice did not start' };
  const id = w.next++;
  const reply = new Promise((r) => {
    if (!w.alive) { r({ ok: false, error: 'the voice stopped' }); return; }
    w.waiting.set(id, r);
    setTimeout(() => { if (w.waiting.delete(id)) r({ ok: false, error: 'timed out' }); }, 60000);
  });
  w.child.stdin.write(JSON.stringify({ id, text, voice, out }) + '\n');
  const r = await reply;
  return r.ok ? { ok: true, out } : r;
}

async function avatarManifest() {
  try {
    const file = path.join(AVATAR_DIR, 'manifest.json');
    // `version` changes whenever the bank is rebuilt; the page puts it on every image URL, so cached
    // images from an older bank are never paired with this manifest.
    const [text, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
    return { ...JSON.parse(text), version: Math.round(st.mtimeMs) };
  } catch { return null; }
}

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  // Refuse DNS-rebinding and cross-site requests: this server can start agents.
  if (!LOCAL_HOSTS.has(req.headers.host || '')) { res.writeHead(403).end('forbidden host'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    const html = (await fsp.readFile(path.join(HERE, 'public', 'index.html'), 'utf8')).replace('__TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    return;
  }
  if (req.method === 'GET' && p === '/events') {
    sse(res); send(res, 'state', state); clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})\/stream$/);
  if (req.method === 'GET' && m) { streamSession(req, res, m[1]); return; }

  if (req.method === 'GET' && p === '/api/digest') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(digest(url.searchParams.get('range') || 'today'), null, 2));
    return;
  }
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
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(man));
    return;
  }
  const av = p.match(/^\/api\/avatar\/((?:base\/\d{4})|(?:pass\d{1,2}))\.jpg$/);
  if (req.method === 'GET' && av) {
    try { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }).end(await fsp.readFile(path.join(AVATAR_DIR, `${av[1]}.jpg`))); }
    catch { res.writeHead(404).end('not found'); }
    return;
  }
  if (req.method === 'POST' && (p === '/api/avatar/speak' || p === '/api/avatar/warm')) {
    if (req.headers['x-console-token'] !== TOKEN) { res.writeHead(403).end('bad token'); return; }
    const man = await avatarManifest();
    if (!man) { res.writeHead(404).end('no avatar bank'); return; }
    if (p === '/api/avatar/warm') { ttsWorker(); res.writeHead(204).end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
    let text = '';
    try { text = String(JSON.parse(raw || '{}').text || '').slice(0, 800).trim(); } catch { /* empty */ }
    if (!text) { res.writeHead(400).end('no text'); return; }
    const r = await speakToFile(text, man.voice || 'bf_emma');
    if (!r.ok) { res.writeHead(503, { 'Content-Type': 'text/plain' }).end(r.error || 'speech failed'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).end(await fsp.readFile(r.out));
    return;
  }
  if (req.method === 'POST' && p === '/api/attach') {
    if (req.headers['x-console-token'] !== TOKEN) { res.writeHead(403).end('bad token'); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 15e6) break; }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
    const r = raw.length > 15e6 ? { ok: false, out: 'Images up to 10 MB only.' } : await saveAttachment(body.dataUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r));
    return;
  }

  const a = p.match(/^\/api\/actions\/([a-z-]+)$/);
  if (req.method === 'POST' && a) {
    if (req.headers['x-console-token'] !== TOKEN) { res.writeHead(403).end('bad token'); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) break; }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
    const result = await act(a[1], body);
    setTimeout(tick, 300);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    return;
  }
  res.writeHead(404).end('not found');
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use. Is CC Mission Control already running? Open http://localhost:${PORT}, or pick another port with --port.`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`CC Mission Control → http://localhost:${PORT}`));
