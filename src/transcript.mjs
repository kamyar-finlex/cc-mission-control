import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_TYPES, PROJ_DIR, RECENT_HOURS, SESS_DIR, TAIL_BYTES } from './config.mjs';

// Claude Code transcripts: parsing their lines, finding them on disk, and the live session registry.


export const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
export const stripReminders = (s) =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function toolSummary(name, input = {}) {
  const v =
    input.command || input.file_path || input.pattern || input.url || input.query ||
    input.description || input.prompt || input.skill || input.to || input.title;
  if (typeof v === 'string') return clip(v.replace(/\s+/g, ' '), 200);
  const keys = Object.keys(input);
  return keys.length ? clip(JSON.stringify(input), 200) : '';
}

export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

// Transcript images are kept by content hash, so events carry a short id and the page loads the picture by URL.
export const images = new Map(); // hash -> { type, data (base64) }
function keepImage(src) {
  if (src?.type !== 'base64' || typeof src.data !== 'string') return undefined;
  const type = src.media_type || 'image/png';
  if (!IMAGE_TYPES[type]) return undefined;
  const h = crypto.createHash('sha1').update(src.data).digest('hex').slice(0, 20);
  if (!images.has(h)) {
    images.set(h, { type, data: src.data });
    if (images.size > 150) images.delete(images.keys().next().value);
  }
  return h;
}
const imagesIn = (content, opts) => (opts.images && Array.isArray(content) ? content.filter((c) => c?.type === 'image').map((c) => keepImage(c.source)).filter(Boolean) : []);

// One transcript line -> zero or more display events.
export function toEvents(d, opts = {}) {
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

export const DISPLAY = new Set(['user', 'assistant', 'tool', 'result']);

export function parseLines(text, opts) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { events.push(...toEvents(JSON.parse(line), opts)); } catch { /* partial line */ }
  }
  return events;
}

// The last `bytes` of a file, starting at a line boundary. One byte before the cut is read too, so a
// cut that lands exactly on the start of a line keeps that line. `complete` is the file offset just
// after the last full line (found in bytes: a newline byte is never part of a multi-byte character).
export async function readTail(file, bytes = TAIL_BYTES) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes - 1);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const data = buf.subarray(0, bytesRead);
    const first = start > 0 ? data.indexOf(0x0a) + 1 : 0;
    const complete = start + data.lastIndexOf(0x0a) + 1;
    return { text: data.subarray(first).toString('utf8'), size: start + bytesRead, complete: Math.max(complete, start + first) };
  } finally { await fh.close(); }
}

export function summarize(events) {
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

export const transcripts = new Map(); // sessionId -> { file, mtime, size }
const summaries = new Map(); // sessionId -> { size, summary }

export async function scanTranscripts() {
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

export async function refreshTranscript(sid) {
  const t = transcripts.get(sid);
  if (!t) return;
  try { const st = await fsp.stat(t.file); t.mtime = st.mtimeMs; t.size = st.size; } catch { /* ignore */ }
}

export async function summaryFor(sid) {
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

export async function readRegistry() {
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

export const projectOf = (cwd = '') => {
  const m = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/);
  return m ? { project: path.basename(m[1]), worktree: m[2] } : { project: path.basename(cwd) || cwd };
};

const cwdFromTranscriptDir = (file) => path.basename(path.dirname(file));
const cwdCache = new Map(); // sid -> cwd for ended sessions

export async function cwdForEnded(sid, file) {
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
export function historyCutoff() {
  if (RECENT_HOURS) return Date.now() - RECENT_HOURS * 3600e3;
  const d = new Date();
  const day = (offset) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return Math.min(monthStart, day((d.getDay() + 6) % 7), day(2));
}
