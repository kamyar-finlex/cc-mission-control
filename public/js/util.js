// Small pure helpers: escaping and formatting. No DOM, so tests and the server can import them.

// Newest activity first, ties by id. The server sorts the board with this too, so a page that
// applies patches keeps exactly the order a fresh load would have.
export const bySessionOrder = (a, b) => (b.lastTs || 0) - (a.lastTs || 0) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A value used as a CSS class: only letters, digits, _ and -, whatever the server or an API sent.
export const cls = (s) => String(s ?? '').replace(/[^\w-]/g, '');

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : n);
export const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
export const kindLabel = { app: 'App', terminal: 'Terminal', background: 'Background', sdk: 'SDK', ended: 'Ended' };
