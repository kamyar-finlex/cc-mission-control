import { isQuietRun } from './schedules.js';

// What every module shares: the DOM helper, saved settings, page state, toasts and actions.
// Signed in by an HttpOnly cookie; this header tells the server a request came from this page.
export const ACT_HEADERS = { 'X-Console-Request': '1' };
export const $ = (id) => document.getElementById(id);
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Page state that more than one module changes.
export const ui = {
  sessions: [],
  selected: null,
  filter: '',
  range: store.get('range', 'today'),
  showArchived: false,
  notify: store.get('notify', false) && 'Notification' in window && Notification.permission === 'granted',
  folds: store.get('folds', { linear: true, prs: true, deploys: true }),
  autoSend: store.get('autoSend', false),
  usage: {},
  // Scheduled runs that say they had nothing to do: 'move' (not new; to Ended after 30 min), 'now'
  // (not new; to Ended at once), 'stay' (not new; stays in Waiting) or 'off' (like any session).
  quietRuns: store.get('quietRuns', 'move'),
};

export const isArchived = (s) => !!(s.archived || s.appArchived);
export let seen = store.get('seen', {});

export const prevPhase = new Map();
export const QUIET_MOVE_MS = 30 * 60e3;
export const isQuiet = (s) => ui.quietRuns !== 'off' && isQuietRun(s);
// Where a quiet run is shown: in Ended once the setting says so, otherwise where its phase puts it.
export const quietMoved = (s) => isQuiet(s) && (ui.quietRuns === 'now' || (ui.quietRuns === 'move' && Date.now() - (s.lastTs || 0) > QUIET_MOVE_MS));
export const isUnread = (s) => s.phase === 'waiting' && s.lastTs && s.lastTs > (seen[s.sessionId] || 0) && s.lastKind !== 'user' && !isQuiet(s);

// Replace markup only when it changed, so live updates don't swallow clicks.
// The keyboard focus survives: if it was inside, the matching element in the new markup gets it back.
const FOCUS_KEYS = ['data-sid', 'data-node', 'data-why', 'data-project', 'data-quick', 'data-prs', 'data-tickets', 'data-sgroup'];
export function setHtml(el, html) {
  if (el._html === html) return;
  const f = el.contains(document.activeElement) ? document.activeElement : null;
  const key = f && FOCUS_KEYS.find((k) => f.hasAttribute(k));
  const sel = key && `[${key}="${CSS.escape(f.getAttribute(key))}"]${f.classList[0] ? `.${CSS.escape(f.classList[0])}` : ''}`;
  el._html = html; el.innerHTML = html;
  if (sel) el.querySelector(sel)?.focus({ preventScroll: true });
}

export function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

// A page whose sign-in the console no longer accepts can't act: reload it once (the reload shows
// how to sign in again if that is what's needed) and the user retries.
export function staleToken(r) {
  if (r.status !== 401 && r.status !== 403) return false;
  let tried = false; try { tried = sessionStorage.getItem('tokenReload') === '1'; sessionStorage.setItem('tokenReload', '1'); } catch {}
  toast(tried ? 'The console refused this page. Reload it.' : 'This page was out of date with the console. Reloading, then try again.', 5000);
  if (!tried) setTimeout(() => location.reload(), 900);
  return true;
}
try { setTimeout(() => sessionStorage.removeItem('tokenReload'), 10000); } catch {}

export async function action(name, body = {}) {
  try {
    const r = await fetch(`/api/actions/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ACT_HEADERS }, body: JSON.stringify(body) });
    if (staleToken(r)) return { ok: false };
    const j = await r.json();
    toast(j.out || (j.ok ? 'Done' : 'Failed'), j.ok ? 2600 : 6000);
    return j;
  } catch (e) { toast('Console server unreachable'); return { ok: false }; }
}
