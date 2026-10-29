import { renderBoard } from './board.js';
import { $, prevPhase, toast, ui } from './core.js';
import { markSeen, openSession, renderHead } from './drawer.js';
import { renderStory } from './story.js';
import { ago, bySessionOrder, esc } from './util.js';
import { renderWhy } from './why.js';

// The live connection: board state over SSE, and reloading when a newer page is deployed.

function onState(list) {
  for (const s of list) {
    const before = prevPhase.get(s.sessionId);
    const watching = ui.selected === s.sessionId && !document.hidden;
    if (before === 'working' && s.phase === 'waiting' && ui.notify && !watching) {
      try {
        const n = new Notification(`${s.title}`, { body: `Waiting for you · ${s.project}\n${(s.lastAssistant || '').slice(0, 140)}`, tag: s.sessionId });
        n.onclick = () => { window.focus(); openSession(s.sessionId); };
      } catch {}
    }
    prevPhase.set(s.sessionId, s.phase);
  }
  ui.sessions = list;
  if (ui.selected) {
    const s = ui.sessions.find((x) => x.sessionId === ui.selected);
    if (s) { markSeen(s); renderHead(s); }
  }
  if ($('storyDlg').open) renderStory();
  if ($('whyDlg').open) renderWhy();
  renderBoard();
  $('cwds').innerHTML = [...new Set(ui.sessions.map((s) => s.cwd))].map((c) => `<option value="${esc(c)}">`).join('');
}

let uiVersion = '';
let reloadPending = false;
function reloadWhenIdle(retry) {
  if (reloadPending && !retry) return;
  reloadPending = true;
  const busy = document.querySelector('dialog[open]') || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || $('menu').classList.contains('open');
  if (busy) { setTimeout(() => reloadWhenIdle(true), 3000); return; }
  location.reload();
}
export function connect() {
  const es = new EventSource('/events');
  // A newer console page was deployed: reload once nothing is being typed or shown in a dialog.
  const checkVersion = (v) => { if (v) { if (!uiVersion) uiVersion = v; else if (v !== uiVersion) reloadWhenIdle(); } };
  // The whole board once, on every (re)connect...
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    checkVersion(d.uiVersion);
    ui.usage = d.usage || ui.usage; onState(d.sessions);
  });
  // ...then only what changed: sessions added or updated, sessions gone, new usage, a new page version.
  es.addEventListener('patch', (e) => {
    const d = JSON.parse(e.data);
    checkVersion(d.uiVersion);
    if (d.usage) ui.usage = d.usage;
    if (!d.upsert && !d.remove) { onState(ui.sessions); return; }
    const byId = new Map(ui.sessions.map((s) => [s.sessionId, s]));
    for (const id of d.remove || []) byId.delete(id);
    for (const s of d.upsert || []) byId.set(s.sessionId, s);
    onState([...byId.values()].sort(bySessionOrder));
  });
  es.onopen = () => $('live').classList.add('on');
  es.onerror = async () => {
    $('live').classList.remove('on');
    // A browser that is no longer signed in would retry forever on a frozen board: say what to do instead.
    const r = await fetch('/api/whoami').catch(() => null);
    if (r?.status === 401) { es.close(); toast('Signed out of the console. Run  cc-mission-control open  in a terminal, then use the page it opens.', 600000); }
  };
}

setInterval(() => document.querySelectorAll('.age[data-ts]').forEach((el) => { el.textContent = ago(Number(el.dataset.ts)); }), 5000);
