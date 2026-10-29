import { $, isArchived, isUnread, setHtml, store, ui } from './core.js';
import { DEPLOY_ICON, deploysPanel } from './deploy.js';
import { openSession } from './drawer.js';
import { openQuickReply } from './editor.js';
import { hideMenu, prItem, showMenu, ticketItem } from './menu.js';
import { renderUsage } from './usage.js';
import { ago, cls, esc, kTok, kindLabel, shortModel } from './util.js';
import { openWhy } from './why.js';

// The board: time ranges, filtering, cards and their chips, and the columns they sit in.

// Calendar ranges by last activity, in local time. The week starts on Monday.
export const RANGES = [
  ['today', 'Today'], ['2d', 'Last two days'], ['3d', 'Last three days'],
  ['week', 'This week'], ['month', 'This month'], ['all', 'All'],
];
function rangeStart(key) {
  const d = new Date();
  const day = (back) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  switch (key) {
    case 'today': return day(0);
    case '2d': return day(1);
    case '3d': return day(2);
    case 'week': return day((d.getDay() + 6) % 7);
    case 'month': return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    default: return 0;
  }
}
const inRange = (s, key) => s.phase === 'working' || (s.lastTs || 0) >= rangeStart(key);

function renderRanges() {
  setHtml($('ranges'), RANGES.map(([key, label], i) => {
    const n = ui.sessions.filter((s) => isArchived(s) === ui.showArchived && inRange(s, key)).length;
    return `<button data-range="${key}" class="${ui.range === key ? 'on' : ''}" aria-pressed="${ui.range === key}" title="${label} (${i + 1})">${label}<span class="c">${n}</span></button>`;
  }).join(''));
}
$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]'); if (b) setRange(b.dataset.range);
});
export function setRange(key) { ui.range = key; store.set('range', key); renderBoard(); }

function visible() {
  const q = ui.filter.toLowerCase();
  return ui.sessions.filter((s) => isArchived(s) === ui.showArchived && inRange(s, ui.range) &&
    (!q || [s.title, s.project, s.worktree, s.branch, s.cwd, s.lastAssistant, s.lastUser,
      ...(s.linear?.tickets || []).flatMap((t) => [t.id, t.title, t.project]), ...(s.linear?.projects || []).map((p) => p.name)]
      .join(' ').toLowerCase().includes(q)));
}

function cardHtml(s) {
  const last = s.phase === 'working' && s.lastKind === 'tool' && s.lastTool
    ? `<div class="last tool">⚙ ${esc(s.lastTool)}</div>`
    : s.summary && s.phase !== 'working'
      ? `<div class="last summary" title="The Claude app's summary of the last turn">${esc(s.summary)}</div>`
      : `<div class="last">${esc(s.lastAssistant || s.lastUser || s.lastTool || '')}</div>`;
  const where = [s.project, s.worktree ? `⎇ ${s.worktree}` : s.branch ? `⎇ ${s.branch}` : ''].filter(Boolean).map(esc).join(' · ');
  return `<div class="card ${isUnread(s) ? 'unread' : ''} ${ui.selected === s.sessionId ? 'sel' : ''} ${s.linear?.projects?.length ? 'has-proj' : ''}" data-sid="${esc(s.sessionId)}" tabindex="0">
    <div class="top"><span class="dot ${cls(s.phase)}"></span><span class="title" title="${esc(s.title + (s.story?.written?.text || s.story?.stitched ? `\n\n${s.story.written?.text || s.story.stitched}` : ''))}">${esc(s.title)}</span>
      <button class="rbtn ${s.phase === 'waiting' ? 'show' : ''}" data-quick="${esc(s.sessionId)}" title="Reply (Markdown)">✎ Reply</button>${whyBtn(s)}${isUnread(s) ? '<span class="tag new">NEW</span>' : ''}<span class="age" data-ts="${esc(s.lastTs || '')}">${ago(s.lastTs)}</span></div>
    <div class="meta">${where}<span class="tag">${esc(kindLabel[s.kind] || s.kind)}</span>${s.model ? `<span class="tag">${esc(shortModel(s.model))}</span>` : ''}${s.ctx ? `<span class="tag" title="Context in use">${kTok(s.ctx)} ctx</span>` : ''}</div>
    ${last}${aliveHtml(s)}${linksHtml(s)}${treeHtml(s.sessionId)}${projTab(s)}</div>`;
}

// Why a waiting session is still alive, in one line; clicking it opens the full list.
const ALIVE_ICON = { ask: '?', block: '⛔', ship: '🚀', wip: '⏳', done: '✓' };
function aliveHtml(s) {
  const a = s.phase === 'waiting' && s.alive; if (!a) return '';
  return `<div class="alive t-${cls(a.tone)}" data-why="${esc(s.sessionId)}" title="Why it's still waiting: click for everything open">
    <span class="ic">${ALIVE_ICON[a.tone] || '•'}</span><span class="tx">${esc(a.text)}</span>${a.more ? `<span class="more">+${a.more} more</span>` : ''}</div>`;
}

// Every waiting session gets a "?": filled when it asked you something, quiet when it just finished.
function whyBtn(s) {
  if (s.phase !== 'waiting') return '';
  const w = s.story?.waitingOn;
  const asks = !!w?.ask;
  const open = s.alive && s.alive.tone !== 'done' ? Math.max(1, (s.openCheck ? s.openCheck.items : s.openItems || []).length) : 0;
  const tip = asks ? `It asks: ${w.ask}` : open ? `${open} thing${open === 1 ? '' : 's'} still open` : 'Why is it waiting?';
  return `<button class="qbtn ${asks || open ? '' : 'quiet'}" data-why="${esc(s.sessionId)}" title="${esc(tip)}">?</button>`;
}

// The Linear project hangs under the card like a tab; clicking it filters the board.
function projTab(s) {
  const p = s.linear?.projects?.[0]; if (!p) return '';
  return `<span class="ptab ${ui.filter === p.name ? 'on' : ''}" data-project="${esc(p.name)}" title="${esc(p.name)}\nClick to show only this project's sessions">◇ <span class="nm">${esc(p.name)}</span></span>`;
}

// Sessions started from this one (the app's linked sessions), drawn as a tree.
let childrenOf = new Map();
function treeHtml(sid, depth = 0) {
  const kids = childrenOf.get(sid);
  if (!kids?.length || depth > 4) return '';
  return `<div class="tree">${kids.map((k) => {
    const open = cardPrs(k).shown.map(prChip).join('');
    return `<div class="branch"><div class="node ${ui.selected === k.sessionId ? 'sel' : ''}" data-node="${esc(k.sessionId)}" title="${esc(k.summary || k.lastAssistant || k.title)}">
      <span class="dot ${cls(k.phase)}"></span><span class="ntitle">${esc(k.title)}</span>${whyBtn(k)}${isUnread(k) ? '<span class="tag new">NEW</span>' : ''}${open}
      <span class="age" data-ts="${esc(k.lastTs || '')}">${ago(k.lastTs)}</span></div>${treeHtml(k.sessionId, depth + 1)}</div>`;
  }).join('')}</div>`;
}

// Linear's "In Review" is a started state; give it its own colour.
export const stClass = (t) => (/review/i.test(t.status || '') ? 'review' : cls(t.statusType) || (t.status ? 'unstarted' : 'backlog'));
export const ticketTip = (t) => [`${t.id}${t.title ? ` — ${t.title}` : ''}`,
  [t.status, t.priority && t.priority !== 'No priority' ? t.priority : '', t.assignee].filter(Boolean).join(' · '),
  t.project ? `Project: ${t.project}` : '', t.updatedAt ? `Linear data as of ${new Date(t.updatedAt).toLocaleString()}` : 'Not fetched from Linear yet'].filter(Boolean).join('\n');

export const PR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>';

// An open PR that still needs something: review, green checks, or leaving draft.
export function prClass(p) {
  if (p.state === 'MERGED') return 'merged';
  if (p.state && p.state !== 'OPEN') return 'done';
  if (!p.state) return 'wait';
  if (p.isDraft) return 'draft';
  if (p.review === 'CHANGES_REQUESTED' || p.checks === 'FAILURE' || p.checks === 'ERROR') return 'bad';
  if (p.review === 'APPROVED' && (!p.checks || p.checks === 'SUCCESS')) return 'ok';
  return 'wait';
}
export const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
const CHECKS = { SUCCESS: 'checks passing', FAILURE: 'checks failing', ERROR: 'checks erroring', PENDING: 'checks running', EXPECTED: 'checks expected' };
export function prTip(p) {
  if (!p.state) return `${p.repo}#${p.number} — checking GitHub…`;
  const state = p.state === 'OPEN' ? (p.isDraft ? 'Draft' : 'Open') : p.state === 'UNKNOWN' ? 'Not visible to gh' : p.state[0] + p.state.slice(1).toLowerCase();
  return [`${p.repo}#${p.number}${p.title ? ` — ${p.title}` : ''}`,
    [state, p.state === 'OPEN' && REVIEW[p.review], p.state === 'OPEN' && CHECKS[p.checks]].filter(Boolean).join(' · ')].join('\n');
}
const prChip = (p) => `<a class="prchip ${prClass(p)}" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(prTip(p))}">${PR_ICON}#${esc(p.number)}</a>`;
const ticketChip = (t, full) => `<a class="lchip ${full ? '' : 'mini'}" href="${esc(t.url || '#')}" target="_blank" rel="noopener" title="${esc(ticketTip(t))}">
  <span class="sdot ${stClass(t)}"></span><span class="id">${esc(t.id)}</span>${t.status ? `<span class="st">${esc(t.status)}</span>` : ''}${full && t.title ? `<span class="nm">· ${esc(t.title)}</span>` : ''}</a>`;

// Only PRs GitHub has answered for (so nothing flickers in and out while
// loading): open ones first, otherwise the latest merged; the rest in a menu.
export function cardPrs(s) {
  const known = (s.prs || []).filter((p) => p.state && p.state !== 'UNKNOWN');
  const open = known.filter((p) => p.state === 'OPEN');
  const merged = known.filter((p) => p.state === 'MERGED').sort((a, b) => (b.mergedAt || '').localeCompare(a.mergedAt || ''));
  const shown = open.length ? open.slice(0, 2) : merged.slice(0, 1);
  return { shown, rest: known.length - shown.length, all: [...open, ...merged, ...known.filter((p) => p.state !== 'OPEN' && p.state !== 'MERGED')] };
}

function linksHtml(s) {
  const L = s.linear;
  const { shown, rest } = cardPrs(s);
  const [latest, ...older] = L?.tickets || [];
  if (!latest && !shown.length) return '';
  const chips = [];
  if (shown.length) chips.push(`<span class="prs">${shown.map(prChip).join('')}${rest ? `<button class="prmore" data-prs="${esc(s.sessionId)}" title="All pull requests of this session">+${rest} ▾</button>` : ''}</span>`);
  // The latest task on the card (id and status; titles are in the dropdown), the others one click away.
  if (latest) chips.push(`<span class="tks">${ticketChip(latest, false)}${older.length ? `<button class="prmore" data-tickets="${esc(s.sessionId)}" title="All Linear tickets of this session">+${older.length} ▾</button>` : ''}</span>`);
  return `<div class="links">${chips.join('')}</div>`;
}

export const section = (key, head, rows) =>
  `<details class="linear" data-fold="${key}" ${ui.folds[key] !== false ? 'open' : ''}><summary class="lhead">${head}</summary>${rows}</details>`;

export function linearPanel(s) {
  const prs = (s.prs || []).length
    ? section('prs', `Pull requests <span class="cnt">${s.prs.length}</span>`, s.prs.map((p) => `<a class="lrow" href="${esc(p.url)}" target="_blank" rel="noopener">
        <span class="lid"><span class="prchip ${prClass(p)}">${PR_ICON}#${esc(p.number)}</span></span><span class="lt"><div>${esc(p.title || `${p.repo}#${p.number}`)}</div><div class="lm">${esc(prTip(p).split('\n')[1] || '')} · ${esc(p.repo)}</div></span></a>`).join(''))
    : '';
  return deploysPanel(s) + linearTickets(s) + prs;
}

export function storyPanel(s) {
  const st = s.story; if (!st || (!st.written && !st.stitched)) return '';
  const w = st.written;
  const text = w ? w.text : st.stitched;
  const meta = w
    ? `Written by Claude ${esc(w.model || '')} · ${ago(w.at)} ago from ${w.turns} turn${w.turns === 1 ? '' : 's'}${w.stale ? ` · <span class="stale">${st.turns - w.turns} newer turn${st.turns - w.turns === 1 ? '' : 's'}</span>` : ''}`
    : `Stitched from ${st.turns ? `${st.turns} turn recap${st.turns === 1 ? '' : 's'}` : 'the latest reply'}`;
  const btn = writingStory.has(s.sessionId)
    ? `<button disabled>Writing…</button>`
    : `<button data-act="summarize" title="Have Claude (Haiku) write one paragraph from this session's requests and turn recaps">${w ? '↻ Refresh with Claude' : '✦ Write with Claude'}</button>`;
  return `<div class="story">${esc(text)}</div><div class="smeta">${meta}<span class="sbtns"><button data-act="copy-story" title="Copy the story">⧉ Copy</button>${btn}</span></div>`;
}
export const writingStory = new Set();

// One line of chips that stands in for the panels while the details are collapsed.
export function miniPanel(s) {
  const chips = [...(s.deploys || []).filter((x) => x.stage !== 'prod').map((x) => `<span class="lchip dchip st-${cls(x.stage)}" title="${esc(x.label)}: ${esc(x.evidence)}">${DEPLOY_ICON[x.stage]} <span class="id">${esc(x.repo)} ${esc(x.version)}</span></span>`),
    ...(s.linear?.tickets || []).slice(0, 3).map((t, i) => ticketChip(t, i === 0)), ...(s.prs || []).filter((p) => p.state === 'OPEN').map(prChip)];
  return chips.join('');
}

function linearTickets(s) {
  const L = s.linear; if (!L) return '';
  const head = L.projects.map((p) => p.url
    ? `<a class="lchip" href="${esc(p.url)}" target="_blank" rel="noopener">◇ ${esc(p.name)}${p.status ? ` · ${esc(p.status)}` : ''}</a>`
    : `<span class="lchip">◇ ${esc(p.name)}</span>`).join('');
  const rows = L.tickets.map((t) => `<a class="lrow" href="${esc(t.url || '#')}" target="_blank" rel="noopener" title="${esc(ticketTip(t))}">
      <span class="lid"><span class="sdot ${stClass(t)}"></span>${esc(t.id)}</span>
      <span class="lt"><div>${esc(t.title || 'Not fetched from Linear yet')}</div>
        <div class="lm">${esc([t.status, t.priority && t.priority !== 'No priority' ? t.priority : '', t.assignee, t.project, t.labels?.length ? t.labels.join(', ') : ''].filter(Boolean).join(' · '))}</div></span></a>`).join('');
  return section('linear', `Linear <span class="cnt">${L.tickets.length}</span> ${head}`, rows);
}

export function renderBoard() {
  const v = visible();
  const shown = new Set(v.map((s) => s.sessionId));
  childrenOf = new Map();
  for (const s of v) if (s.parentId && shown.has(s.parentId) && s.parentId !== s.sessionId) {
    if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
    childrenOf.get(s.parentId).push(s);
  }
  const cols = { working: [], waiting: [], ended: [] };
  for (const s of v) if (!(s.parentId && shown.has(s.parentId))) (cols[s.phase] || cols.ended).push(s);
  cols.waiting.sort((a, b) => (isUnread(b) - isUnread(a)) || (b.lastTs || 0) - (a.lastTs || 0));
  const label = RANGES.find(([k]) => k === ui.range)?.[1].toLowerCase() || 'this range';
  const empty = { working: 'Nothing running right now.', waiting: `No session waiting for you from ${label}.`, ended: `No sessions ended ${ui.range === 'all' ? 'in the last month' : label}.` };
  renderRanges();
  // A brand-new machine has no sessions yet: say how to get some instead of showing three blank columns.
  if (!ui.sessions.length) empty.working = 'No Claude Code sessions on this Mac yet. Start one in the Claude app’s Code tab, or run <code>claude</code> in a terminal: it shows up here within a second.';
  for (const k of Object.keys(cols)) {
    setHtml($(`col-${k}`), cols[k].length ? cols[k].map(cardHtml).join('') : `<div class="empty">${empty[k]}</div>`);
    $(`n-${k}`).textContent = cols[k].length;
  }
  const unread = v.filter(isUnread).length;
  const archivedCount = ui.sessions.filter(isArchived).length;
  $('archBtn').textContent = ui.showArchived ? '← Back to board' : `Archived ${archivedCount}`;
  $('stats').innerHTML = `<span class="stat"><b>${cols.working.length}</b> working</span><span class="stat"><b>${unread}</b> new replies</span>`;
  document.title = unread ? `(${unread}) CC Mission Control` : 'CC Mission Control';
  renderUsage();
}

document.querySelector('main').addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // Linear link opens in a new tab
  const why = e.target.closest('[data-why]'); if (why) { openWhy(why.dataset.why); return; }
  const quick = e.target.closest('[data-quick]'); if (quick) { openQuickReply(quick.dataset.quick, quick.closest('.card')); return; }
  const more = e.target.closest('.prmore');
  if (more) {
    const sid = more.dataset.prs || more.dataset.tickets;
    const key = `${more.dataset.prs ? 'prs' : 'tickets'}:${sid}`;
    const s = ui.sessions.find((x) => x.sessionId === sid);
    if ($('menu').classList.contains('open') && $('menu').dataset.for === key) { hideMenu(); return; }
    const r = more.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, more.dataset.prs
      ? `<div class="mh">Pull requests</div>${cardPrs(s).all.map(prItem).join('')}`
      : `<div class="mh">Linear tickets · latest first</div>${(s.linear?.tickets || []).map(ticketItem).join('')}`);
    $('menu').dataset.for = key;
    return;
  }
  const p = e.target.closest('[data-project]');
  if (p) { const name = p.dataset.project; ui.filter = ui.filter === name ? '' : name; $('search').value = ui.filter; renderBoard(); return; }
  const n = e.target.closest('[data-node]'); if (n) { openSession(n.dataset.node); return; }
  const c = e.target.closest('.card'); if (c) openSession(c.dataset.sid);
});
$('archBtn').onclick = () => { ui.showArchived = !ui.showArchived; renderBoard(); };
document.querySelector('main').addEventListener('keydown', (e) => {
  const c = e.target.closest('.card'); if (c && e.key === 'Enter') openSession(c.dataset.sid);
});
