import fs from 'node:fs';
import { clip, resultText, stripReminders, transcripts } from './transcript.mjs';

// Linear tickets and projects, learned from the Linear tool replies already in transcripts.
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
export const linearScans = new Map(); // sessionId -> incremental scan state
// Moves only when the shared catalog really changes, so cached cards know when to rebuild.
export let linearEpoch = 0;
const addTo = (set, v) => { if (!set.has(v)) { set.add(v); linearEpoch++; } };

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
      const merged = { ...prev, ...next };
      if (JSON.stringify(merged) !== JSON.stringify(prev)) { catalog.set(o.id, merged); linearEpoch++; }
      if (next.project) addTo(projectNames, next.project);
    }
    addTo(teamKeys, o.id.split('-')[0]);
  } else if (typeof o.name === 'string' && typeof o.url === 'string' && o.url.includes('linear.app/') && o.url.includes('/project/')) {
    const name = unescapeHtml(o.name);
    const info = { name, url: o.url, status: nameOf(o.status) };
    if (JSON.stringify(info) !== JSON.stringify(projectInfo.get(name))) { projectInfo.set(name, info); linearEpoch++; }
    addTo(projectNames, name);
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') learn(v, depth + 1);
}

function mentions(text, st, weight) {
  for (const [, p, n] of text.matchAll(ISSUE_ID)) ref(st, `${p}-${n}`, weight);
  for (const [, id] of text.matchAll(ISSUE_URL)) { const up = id.toUpperCase(); ref(st, up, weight + 1); st.strong.add(up); addTo(teamKeys, up.split('-')[0]); }
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

export function linearLine(line, st) {
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
        for (const v of [i.id, i.issueId, i.parentId]) if (typeof v === 'string' && IS_ISSUE_ID.test(v)) { ref(st, v, v === i.parentId ? 2 : w); if (v !== i.parentId) st.strong.add(v); }
        if (typeof i.project === 'string') bump(st.projects, i.project, 3);
        if (b.name.endsWith('_project') && typeof i.query === 'string') bump(st.projects, i.query, 3);
      }
    }
  }
}

// One session's scan state. `strong` holds ids with more than a mention behind them: a Linear
// tool call on the ticket or a link to it.
export const newScan = () => ({ offset: 0, carry: '', pending: new Map(), prCreates: new Set(), refs: new Map(), strong: new Set(), projects: new Map(), prs: new Map(), refsAt: new Map(), story: { asks: [], recaps: [], compacts: [] } });

// Reads only the bytes appended since the last scan.
async function scanLinear(sid) {
  const t = transcripts.get(sid);
  if (!t) return;
  let st = linearScans.get(sid);
  if (!st) linearScans.set(sid, (st = newScan()));
  if (t.size < st.offset) Object.assign(st, newScan()); // rewritten
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
export async function linearTick(sessions) {
  if (linearBusy) return;
  linearBusy = true;
  try { for (const s of sessions) await scanLinear(s.sessionId); }
  catch (e) { console.error('linear scan failed', e); }
  finally { linearBusy = false; }
}

// Names of standards and algorithms that look like ticket ids. When a team's key matches one
// (a SHA team has a real SHA-256), a bare mention is still the algorithm: it only counts as a
// ticket with more behind it (the branch, the title, a Linear tool call or link).
const LOOKS_LIKE_A_STANDARD = /^(SHA-(1|2|3|224|256|384|512)|UTF-(7|8|16|32)|MD-[245]|ISO-\d{3,5}|RFC-\d{3,4}|AES-(128|192|256)|RSA-(1024|2048|3072|4096)|X-509|PEP-\d{1,4}|CP-125\d|ES-(256|384|512)|HS-(256|384|512)|RS-(256|384|512)|P-(256|384|521))$/;

// Strongest signals first: the git branch / worktree, then the title, then
// Linear tool calls, then ids the user typed. Only confirmed team keys count,
// so strings like UTF-8 never become tickets for a workspace without a UTF team.
export function linearFor(sid, { title, branch, worktree }) {
  const st = linearScans.get(sid);
  const score = new Map(st?.refs);
  const onBranch = new Set();
  for (const [, p, n] of `${branch || ''} ${worktree || ''}`.toUpperCase().matchAll(ISSUE_ID)) { bump(score, `${p}-${n}`, 100); onBranch.add(`${p}-${n}`); }
  const inTitle = new Set();
  for (const [, p, n] of (title || '').matchAll(ISSUE_ID)) { bump(score, `${p}-${n}`, 50); inTitle.add(`${p}-${n}`); }
  const evidence = (id) => !LOOKS_LIKE_A_STANDARD.test(id) || onBranch.has(id) || inTitle.has(id) || st?.strong.has(id);
  // The ten most relevant tickets, newest first: the branch's ticket is the
  // current task, then the one the session touched last.
  const lastAt = (id) => (onBranch.has(id) ? Infinity : st?.refsAt.get(id) || 0);
  const tickets = [...score]
    .filter(([id, n]) => n >= 3 && teamKeys.has(id.split('-')[0]) && evidence(id))
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
