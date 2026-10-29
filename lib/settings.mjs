// Adding CC Mission Control's status line to ~/.claude/settings.json, and taking it out again,
// without ever losing what is there.

// Ours means exactly what setup writes: "<node>" "<copy>/statusline.mjs". A command of the
// user's own that pipes into statusline.mjs is theirs, and stays untouched. quote() backslash-
// escapes " \ $ and `, so either quoted part may hold escaped characters.
const isOurs = (command) => /^"(?:[^"\\]|\\.)+" "(?:[^"\\]|\\.)*[\\/]statusline\.mjs"$/.test(String(command || ''));

// The file's settings, or { error } when it isn't a JSON object. A leading byte-order mark is allowed.
function parse(raw) {
  let settings;
  try { settings = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { return { error: e.message }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { error: 'not a JSON object' };
  return { settings };
}

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
    const p = parse(raw);
    if (p.error) return { action: 'invalid', error: p.error };
    settings = p.settings;
  }
  const current = settings.statusLine;
  const write = (action) => ({ action, next: `${JSON.stringify({ ...settings, statusLine: { ...(current || {}), type: 'command', command } }, null, 2)}\n` });
  if (!current) return write('add');
  const existing = String(current.command || '');
  if (!isOurs(existing)) return { action: 'foreign' };
  return existing === command ? { action: 'current' } : write('update');
}

// For uninstall: removes the status line only when it is exactly the one setup wrote.
// Returns { action: 'remove', next } | { action: 'none' } | { action: 'foreign' } | { action: 'invalid', error }.
export function planRemoveStatusLine(raw) {
  if (raw === null) return { action: 'none' };
  const p = parse(raw);
  if (p.error) return { action: 'invalid', error: p.error };
  if (!p.settings.statusLine) return { action: 'none' };
  if (!isOurs(p.settings.statusLine.command)) return { action: 'foreign' };
  const { statusLine, ...rest } = p.settings;
  return { action: 'remove', next: `${JSON.stringify(rest, null, 2)}\n` };
}
