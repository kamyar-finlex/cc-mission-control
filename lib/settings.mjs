// Adding CC Mission Control's status line to ~/.claude/settings.json without ever losing what is there.

// Decides what to do with the settings file's current text (null when the file doesn't exist).
// Returns { action, next? }:
//   add      no status line yet; `next` is the new file text
//   update   ours, but pointing at another node or another copy; `next` is the new file text
//   current  ours and up to date
//   foreign  someone else's status line; left alone
//   invalid  the file isn't a JSON object; left alone (with `error`)
export function planStatusLine(raw, command) {
  let settings = {};
  if (raw !== null) {
    try { settings = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { return { action: 'invalid', error: e.message }; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { action: 'invalid', error: 'not a JSON object' };
  }
  const current = settings.statusLine;
  const write = (action) => ({ action, next: `${JSON.stringify({ ...settings, statusLine: { ...(current || {}), type: 'command', command } }, null, 2)}\n` });
  if (!current) return write('add');
  const existing = String(current.command || '');
  // Ours means exactly what setup writes: "<node>" "<copy>/statusline.mjs". A command of the
  // user's own that pipes into statusline.mjs is theirs, and stays untouched.
  if (!/^"[^"]+" "[^"]*[\\/]statusline\.mjs"$/.test(existing)) return { action: 'foreign' };
  return existing === command ? { action: 'current' } : write('update');
}
