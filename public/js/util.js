// Small pure helpers: escaping and formatting. No DOM, so tests can import them.

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
