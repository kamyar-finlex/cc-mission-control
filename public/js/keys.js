import { RANGES, renderBoard, setRange } from './board.js';
import { $, ACT_HEADERS, action, staleToken, store, toast, ui } from './core.js';
import { closeDrawer, current, openSession, renderHead, runAction, toggleFold, toggleMax } from './drawer.js';
import { closeQuickReply } from './editor.js';
import { hideMenu } from './menu.js';
import { openStory } from './story.js';

// Send to agent, notifications, search and keyboard shortcuts.

export function renderSendBtn() {
  $('sendBtn').textContent = `Send to agent: ${ui.autoSend ? 'on' : 'off'}`;
  $('sendBtn').classList.toggle('primary', ui.autoSend);
  $('compose').dataset.sig = ''; const s = current(); if (s) renderHead(s); // replies relabel
}
export async function showAutoStatus() {
  const r = await fetch('/api/actions/automation-status', { method: 'POST', headers: { 'Content-Type': 'application/json', ...ACT_HEADERS }, body: '{}' })
    .then((x) => (staleToken(x) ? { ok: false, out: 'Reloading the page…' } : x.json())).catch(() => ({ ok: false, out: 'Console unreachable' }));
  const msg = r.ok ? '✓ Allowed. Send to agent can be turned on.'
    : r.why === 'accessibility' ? '✗ Accessibility is not allowed for node yet (steps 1 to 3).'
    : r.why === 'automation' ? '✗ node may not control System Events yet: allow it in Privacy & Security → Automation (step 4).'
    : r.why === 'app-closed' ? '✗ The Claude app is not running.'
    : `✗ Not allowed yet: ${r.out}`;
  $('ad-status').textContent = msg;
  if (r.node) $('ad-node').textContent = r.node;
  return r.ok;
}
$('sendBtn').onclick = async () => {
  if (ui.autoSend) { ui.autoSend = false; store.set('autoSend', false); renderSendBtn(); toast('Send to agent is off: replies are copied and the session opens.'); return; }
  $('autoDlg').showModal(); await showAutoStatus();
};
$('ad-cancel').onclick = () => $('autoDlg').close();
$('ad-open').onclick = () => action('open-ax-settings');
$('ad-copy').onclick = () => { navigator.clipboard?.writeText($('ad-node').textContent); toast('Path copied'); };
$('ad-check').onclick = async () => {
  if (await showAutoStatus()) { ui.autoSend = true; store.set('autoSend', true); renderSendBtn(); $('autoDlg').close(); toast('Send to agent is on.'); }
};

function renderNotify() { $('notifyBtn').textContent = `Notify: ${ui.notify ? 'on' : 'off'}`; }
$('notifyBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('Notifications are not supported here');
  if (!ui.notify && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications blocked by the browser');
  }
  ui.notify = !ui.notify; store.set('notify', ui.notify); renderNotify();
};
renderNotify();
renderSendBtn();

$('search').addEventListener('input', (e) => { ui.filter = e.target.value; renderBoard(); });

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || !!document.activeElement?.isContentEditable;
  if (e.key === 'Escape' && !$('lightbox').hidden) { $('lightbox').hidden = true; return; }
  if (e.key === 'Escape' && !$('qr').hidden) { closeQuickReply(); return; }
  if (e.key === 'Escape' && $('menu').classList.contains('open')) { hideMenu(); return; }
  // An open dialog owns the keyboard: Escape closes just the dialog, and shortcuts wait.
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { if (typing) { document.activeElement.blur(); return; } closeDrawer(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f' && $('drawer').classList.contains('open')) toggleMax();
  else if (e.key === 'd' && $('drawer').classList.contains('open')) toggleFold();
  else if (e.key === 's' && ui.selected) openStory(ui.selected);
  else if (e.key === 'r' && ui.selected) { e.preventDefault(); runAction('reply', ui.selected); }
  else if (e.key >= '1' && e.key <= String(RANGES.length)) setRange(RANGES[Number(e.key) - 1][0]);
  else if (e.key === '/') { e.preventDefault(); $('search').focus(); }
  else if (e.key === 'n') { e.preventDefault(); $('newBtn').click(); }
  else if (e.key === 'j' || e.key === 'k') {
    const cards = [...document.querySelectorAll('.card')];
    if (!cards.length) return;
    const i = cards.findIndex((c) => c.dataset.sid === ui.selected);
    const next = cards[Math.min(cards.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))] || cards[0];
    openSession(next.dataset.sid); next.scrollIntoView({ block: 'nearest' });
  }
});
