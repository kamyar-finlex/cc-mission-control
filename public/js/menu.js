import { PR_ICON, REVIEW, cardPrs, prClass, prTip, stClass, ticketTip } from './board.js';
import { $, ui } from './core.js';
import { current, runAction, sessionActions } from './drawer.js';
import { ago, esc } from './util.js';

// The right-click menu and the PR dropdown.

let menuOpener = null;
export function showMenu(x, y, html) {
  const m = $('menu');
  if (!m.classList.contains('open')) menuOpener = document.activeElement;
  m.innerHTML = html; m.classList.add('open');
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  m.querySelector('.mi')?.focus();
}
export function hideMenu() {
  const m = $('menu');
  const hadFocus = m.contains(document.activeElement);
  m.classList.remove('open'); m.dataset.for = '';
  if (hadFocus && menuOpener?.isConnected) menuOpener.focus(); // only when the menu held the focus
  menuOpener = null;
}
// Arrow keys, Home and End move between the menu's items.
$('menu').addEventListener('keydown', (e) => {
  const items = [...$('menu').querySelectorAll('.mi')];
  const i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
});

const mi = (o) => o.href
  ? `<a class="mi" role="menuitem" href="${esc(o.href)}" target="_blank" rel="noopener"${o.title ? ` title="${esc(o.title)}"` : ''}><span class="ic">${o.icon || ''}</span><span class="tx">${o.html || esc(o.label)}</span>${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</a>`
  : `<button class="mi ${o.danger ? 'danger' : ''}" role="menuitem" data-mact="${esc(o.act)}" data-sid="${esc(o.sid)}"${o.title ? ` title="${esc(o.title)}"` : ''}><span class="ic">${o.icon || ''}</span><span class="tx">${esc(o.label)}</span>${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</button>`;
export const ticketItem = (t) => mi({ href: t.url || '#', icon: `<span class="sdot ${stClass(t)}" aria-hidden="true"></span>`, label: `${t.id} ${t.title || ''}`, sub: t.status || '', title: ticketTip(t) + (t.onBranch ? '\nOn this branch' : t.lastAt ? `\nLast touched ${ago(t.lastAt)} ago` : '') });
export const prItem = (p) => mi({ href: p.url, icon: `<span class="prchip ${prClass(p)}" style="padding:0 3px">${PR_ICON}</span>`, label: `#${p.number} ${p.title || ''}`, sub: p.state === 'OPEN' ? (p.isDraft ? 'Draft' : REVIEW[p.review] || 'Open') : p.state[0] + p.state.slice(1).toLowerCase(), title: prTip(p) });

function sessionMenu(s, { inDrawer = false } = {}) {
  const items = inDrawer ? [] : [mi({ act: 'details', sid: s.sessionId, label: 'Open details', icon: '☰' })];
  if (s.phase === 'waiting') items.push(mi({ act: 'why', sid: s.sessionId, label: s.story?.waitingOn?.ask ? 'Why is it waiting? (it asks you)' : 'Why is it waiting?', icon: '?' }));
  items.push(mi({ act: 'reply', sid: s.sessionId, label: 'Reply…', icon: '✎', sub: 'r' }));
  items.push(mi({ act: 'story', sid: s.sessionId, label: 'Show story', icon: '❝', sub: 's' }));
  for (const a of sessionActions(s)) items.push(mi({ ...a, sid: s.sessionId }));
  if (inDrawer) return items.join(''); // tickets and PRs are already listed in the drawer
  const tickets = s.linear?.tickets || [];
  if (tickets.length) items.push('<div class="sep"></div><div class="mh">Linear</div>', ...tickets.map(ticketItem));
  const prs = cardPrs(s).all;
  if (prs.length) items.push('<div class="sep"></div><div class="mh">Pull requests</div>', ...prs.map(prItem));
  return items.join('');
}

document.querySelector('main').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-node], .card'); if (!el) return;
  const s = ui.sessions.find((x) => x.sessionId === (el.dataset.node || el.dataset.sid)); if (!s) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, `<div class="mh" style="text-transform:none;letter-spacing:0">${esc(s.title)}</div>${sessionMenu(s)}`);
});
const drawerMenu = (x, y) => { const s = current(); if (s) showMenu(x, y, sessionMenu(s, { inDrawer: true })); };
$('d-more').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); drawerMenu(r.right - 220, r.bottom + 4); };
document.querySelector('#drawer .dhead').addEventListener('contextmenu', (e) => {
  if (e.target.closest('a')) return;
  e.preventDefault(); drawerMenu(e.clientX, e.clientY);
});
$('menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mact]');
  if (e.target.closest('a.mi')) { hideMenu(); return; }
  if (!b) return;
  hideMenu();
  await runAction(b.dataset.mact, b.dataset.sid);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('.prmore') && !e.target.closest('#d-more')) hideMenu(); });
addEventListener('blur', hideMenu);
document.querySelector('main').addEventListener('scroll', hideMenu, true);
