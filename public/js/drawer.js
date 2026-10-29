import { av, avatarLoad, avatarPoster, avatarSay, avatarStop } from './avatar.js';
import { linearPanel, miniPanel, renderBoard, writingStory } from './board.js';
import { $, action, isArchived, seen, setHtml, store, toast, ui } from './core.js';
import { delivery, editorHtml, openQuickReply } from './editor.js';
import { md } from './markdown.js';
import { openStory, renderStory, storySid } from './story.js';
import { esc, kTok, kindLabel, shortModel } from './util.js';
import { openWhy } from './why.js';

// The session drawer: its header and actions, and the live transcript feed.

let stream = null;
let lastCount = 0;

export function markSeen(s) {
  if (!s.lastTs || (seen[s.sessionId] || 0) >= s.lastTs) return;
  seen[s.sessionId] = s.lastTs; store.set('seen', seen);
}

// One list of session actions, used by the drawer buttons and the right-click menu.
export function sessionActions(s) {
  const a = [];
  if (s.kind === 'app' || s.appId) a.push({ act: 'open-app', label: 'Open in Claude app', icon: '↗', primary: true });
  else if (s.kind === 'background' && s.running) a.push({ act: 'terminal', label: 'Attach in Terminal', icon: '⌨', primary: true }, { act: 'stop', label: 'Stop', icon: '■', danger: true });
  else if (!s.running) a.push({ act: 'terminal', label: 'Resume in Terminal', icon: '⌨' });
  if (isArchived(s)) a.push({ act: 'unarchive', label: 'Unarchive', icon: '↺' });
  else a.push({ act: 'archive', label: 'Archive', icon: '🗄', title: s.kind === 'background' ? 'Stops and removes this background agent' : s.appId ? 'Hides it here; archive it in the app to hide it there too' : 'Hides it from the board' });
  a.push({ act: 'copy-id', label: 'Copy id', icon: '⧉' });
  return a;
}

export async function runAction(act, sid) {
  const s = ui.sessions.find((x) => x.sessionId === sid);
  if (!s) return;
  if (act === 'copy-id') { navigator.clipboard?.writeText(sid); toast('Session id copied'); return; }
  if (act === 'details') { openSession(sid); return; }
  if (act === 'story') { openStory(sid); return; }
  if (act === 'why') { openWhy(sid); return; }
  if (act === 'reply') {
    if (ui.selected === sid && $('drawer').classList.contains('open')) { $('compose').querySelector('.mde-in')?.focus(); return; }
    openQuickReply(sid); return;
  }
  if (act === 'stop' && !confirm('Stop this background agent? Its conversation is kept.')) return;
  if (act === 'archive' && s.kind === 'background' && !confirm('Archiving a background agent stops it and removes it (claude rm). Continue?')) return;
  if (act === 'summarize') {
    writingStory.add(sid); if (storySid === sid) renderStory();
    toast('Writing the story with Claude…', 4000);
    await action('summarize', { sessionId: sid });
    writingStory.delete(sid); if (storySid === sid) renderStory();
    return;
  }
  await action(act, { sessionId: sid });
}

export function renderHead(s) {
  $('d-dot').className = `dot ${s.phase}`;
  $('d-title').textContent = s.title;
  $('d-sub').textContent = [s.cwd, s.branch && `⎇ ${s.branch}`, kindLabel[s.kind], s.model && shortModel(s.model), s.ctx && `${kTok(s.ctx)} ctx`, s.sessionId].filter(Boolean).join('  ·  ');
  setHtml($('d-linear'), linearPanel(s));
  setHtml($('d-mini'), miniPanel(s));
  $('d-fold').hidden = !$('d-linear').innerHTML;
  // Re-render only when the delivery changes; the text itself lives in the draft store, so typing never resets it.
  const d = delivery(s);
  const sig = `${s.sessionId}|${d.label}`;
  if ($('compose').dataset.sig !== sig) {
    $('compose').dataset.sig = sig;
    $('compose').innerHTML = (s.phase === 'working' ? `<div class="working-bar"><span class="dot working"></span>Working…</div>` : '')
      + editorHtml(`reply:${s.sessionId}`, { placeholder: 'Write a reply or a prompt in Markdown…', send: d.label, hint: `${d.how}  ⌘↩`, agentSwitch: !!s.appId });
  }
  const bar = $('compose').querySelector('.working-bar');
  if (s.phase === 'working' && !bar) $('compose').insertAdjacentHTML('afterbegin', `<div class="working-bar"><span class="dot working"></span>Working…</div>`);
  if (s.phase !== 'working' && bar) bar.remove();
}
const tstr = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

const thumbs = (hashes, alt) => (hashes || []).map((h) => `<img class="thumb" src="/api/images/${esc(h)}" alt="${esc(alt)}" loading="lazy">`).join('');

function evHtml(e) {
  if (e.kind === 'user') return `<div class="ev user md">${e.text ? md(e.text) : ''}${e.images?.length ? `<div class="thumbs">${thumbs(e.images, 'image you sent')}</div>` : ''}</div>`;
  if (e.kind === 'assistant') return `<div class="ev assistant"><span class="av" aria-hidden="true">✳</span><div class="abody md">${md(e.text)}<div class="ts">${tstr(e.ts)}</div></div></div>`;
  return '';
}

function toolIcon(name) {
  if (name === 'Bash') return '⌘';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return '✎';
  if (name === 'Read') return '📄';
  if (/^(Grep|Glob|ToolSearch)$/.test(name)) return '🔍';
  if (/^Web/.test(name)) return '🌐';
  if (/^(Agent|Task|Workflow)$/.test(name)) return '🤖';
  if (/wrap_up|update_plan/.test(name)) return '✓';
  if (/^mcp__/.test(name)) return '🔌';
  return '⚙';
}

// Consecutive tool calls and their results fold into one "steps" row between messages.
function stepGroup(feed) {
  const last = feed.lastElementChild;
  if (last?.classList.contains('steps')) return last;
  feed.insertAdjacentHTML('beforeend', `<div class="ev steps"><details><summary><b class="scount"></b><span class="snames"></span><span class="serr"></span><span class="ts"></span></summary><div class="sbody"></div></details><div class="sthumbs"></div></div>`);
  const g = feed.lastElementChild;
  g._names = []; g._count = 0; g._err = 0;
  return g;
}
function addStep(feed, e) {
  const g = stepGroup(feed);
  const body = g.querySelector('.sbody');
  if (e.kind === 'tool') {
    const name = e.name.replace(/^mcp__.*__/, '');
    g._count += 1;
    if (!g._names.includes(name)) g._names.push(name);
    body.insertAdjacentHTML('beforeend', `<div class="step" data-tid="${esc(e.id || '')}"><span class="ticon">${toolIcon(e.name)}</span><b>${esc(name)}</b><span class="targ" title="${esc(e.text)}">${esc(e.text)}</span><span class="ts">${tstr(e.ts)}</span></div>`);
    g.querySelector('summary .ts').textContent = tstr(e.ts);
  } else {
    if (e.error) g._err += 1;
    const res = e.text ? `<details class="sres ${e.error ? 'err' : ''}"><summary>${e.error ? '✗' : '↳'} ${esc(e.text.split('\n')[0].slice(0, 140))}</summary><pre>${esc(e.text)}</pre></details>` : '';
    const pics = thumbs(e.images, 'tool result image');
    if (res || pics) {
      const html = `<div class="stepres">${res}${pics ? `<div class="thumbs">${pics}</div>` : ''}</div>`;
      const row = e.id && [...body.querySelectorAll('.step')].reverse().find((r) => r.dataset.tid === e.id);
      if (row) row.insertAdjacentHTML('afterend', html); else body.insertAdjacentHTML('beforeend', html);
    }
    if (pics) g.querySelector('.sthumbs').insertAdjacentHTML('beforeend', pics); // screenshots stay visible while folded
  }
  const more = g._names.length > 4 ? ` +${g._names.length - 4}` : '';
  g.querySelector('.scount').textContent = `${g._count} step${g._count === 1 ? '' : 's'}`;
  g.querySelector('.snames').textContent = g._names.slice(0, 4).join(' · ') + more;
  g.querySelector('.serr').textContent = g._err ? `${g._err} failed` : '';
}

function appendEvents(events, initial) {
  const feed = $('feed');
  const nearBottom = initial || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
  for (const e of events) {
    if (e.kind === 'tool' || e.kind === 'result') addStep(feed, e);
    else { const h = evHtml(e); if (h) feed.insertAdjacentHTML('beforeend', h); }
    if (e.kind === 'assistant' && e.text) { av.lastReply = e.text; if (!initial && av.on) avatarSay(e.text); }
  }
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

export function openSession(sid) {
  const s = ui.sessions.find((x) => x.sessionId === sid);
  if (!s) return;
  ui.selected = sid; markSeen(s);
  avatarStop(); av.lastReply = '';
  if (av.on) avatarLoad(); else avatarPoster();
  $('compose').dataset.sig = '';
  renderHead(s); renderBoard();
  $('drawer').classList.add('open');
  $('feed').innerHTML = '<div class="note">Loading…</div>';
  stream?.close();
  stream = new EventSource(`/api/sessions/${sid}/stream`);
  stream.addEventListener('backlog', (e) => {
    const ev = JSON.parse(e.data);
    $('feed').innerHTML = ev.length ? '' : '<div class="note">No transcript yet.</div>';
    appendEvents(ev, true);
  });
  stream.addEventListener('append', (e) => appendEvents(JSON.parse(e.data), false));
}

export function closeDrawer() {
  $('drawer').classList.remove('open'); stream?.close(); stream = null; ui.selected = null; avatarStop(); renderBoard();
}
$('d-close').onclick = closeDrawer;
export function toggleMax() { const on = $('drawer').classList.toggle('max'); store.set('maxDrawer', on); $('d-max').textContent = on ? '⤡' : '⤢'; $('d-max').title = on ? 'Restore (f)' : 'Maximize (f)'; }
$('d-max').onclick = toggleMax;
export function toggleFold() {
  const on = $('drawer').classList.toggle('folded'); store.set('foldDrawer', on);
  $('d-fold').textContent = on ? '▸ Details' : '▾ Details'; $('d-fold').title = on ? 'Show details (d)' : 'Collapse details (d)';
}
$('d-fold').onclick = toggleFold;
if (store.get('foldDrawer', false)) toggleFold();
$('d-linear').addEventListener('toggle', (e) => {
  const key = e.target.dataset?.fold; if (!key) return;
  ui.folds = { ...ui.folds, [key]: e.target.open }; store.set('folds', ui.folds);
}, true);
if (store.get('maxDrawer', false)) toggleMax();
export const current = () => ui.sessions.find((x) => x.sessionId === ui.selected);

$('drawer').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const act = b.dataset.act; if (!act || !ui.selected) return;
  b.disabled = true; await runAction(act, ui.selected); b.disabled = false;
});
