// Tickets learned from transcript lines, and the daily digest built from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CCMC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-linear-'));
const { linearLine, linearFor, linearScans, newScan } = await import('../src/linear.mjs');
const { digest } = await import('../src/digest.mjs');

const day = 864e5;
const at = (ts) => new Date(ts).toISOString();
const user = (text, ts = Date.now()) => JSON.stringify({ type: 'user', timestamp: at(ts), message: { content: text } });
const assistant = (content, ts = Date.now()) => JSON.stringify({ type: 'assistant', timestamp: at(ts), message: { content } });
const toolResult = (id, json) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(json) }] } });
const scan = (sid, lines) => { const st = newScan(); for (const l of lines) linearLine(l, st); linearScans.set(sid, st); return st; };

// The workspace has a SHA team, whose SHA-256 is a real ticket.
scan('setup', [
  assistant([{ type: 'tool_use', id: 't0', name: 'mcp__linear__get_issue', input: { id: 'SHA-256' } }]),
  toolResult('t0', { id: 'SHA-256', title: 'POC1 multi-user sign-in', status: 'Done', statusType: 'completed', url: 'https://linear.app/x/issue/SHA-256' }),
  assistant([{ type: 'tool_use', id: 't1', name: 'mcp__linear__get_issue', input: { id: 'SHA-41' } }]),
  toolResult('t1', { id: 'SHA-41', title: 'Secret scan', status: 'In Progress', statusType: 'started' }),
]);
const ids = (sid, meta = {}) => (linearFor(sid, meta)?.tickets || []).map((t) => t.id);

test('a hash name mentioned in passing is not a ticket, even when a team key matches', () => {
  scan('hashing', [user('Compare the SHA-256 of both files'), user('Use SHA-256 again, and SHA-1 for the legacy ones')]);
  assert.deepEqual(ids('hashing'), []);
});

test('the same name is a ticket when the session works on it', () => {
  scan('tool', [assistant([{ type: 'tool_use', id: 'a', name: 'mcp__linear__get_issue', input: { id: 'SHA-256' } }])]);
  assert.deepEqual(ids('tool'), ['SHA-256']);
  scan('link', [user('See https://linear.app/x/issue/SHA-256/poc1')]);
  assert.deepEqual(ids('link'), ['SHA-256']);
  scan('branch', [user('SHA-256 follow-up')]);
  assert.deepEqual(ids('branch', { branch: 'feat/sha-256-poc' }), ['SHA-256']);
  // A title is often just the first message, so it is not evidence on its own.
  assert.deepEqual(ids('branch', { title: 'Compare the SHA-256 of both files' }), []);
});

test('ordinary ticket ids still count from a mention', () => {
  scan('plain', [user('Pick up SHA-41 next')]);
  assert.deepEqual(ids('plain'), ['SHA-41']);
  scan('rfc-team', [assistant([{ type: 'tool_use', id: 'r', name: 'mcp__linear__get_issue', input: { id: 'RFC-12' } }]),
    toolResult('r', { id: 'RFC-12', title: 'Rate limiter', status: 'Todo' }), user('Then RFC-1234 and RFC-3339')]);
  assert.deepEqual(ids('rfc-team').sort(), ['RFC-12', 'RFC-1234'], 'an RFC team keeps its own tickets; only the standard is filtered');
  scan('unknown-team', [user('Encode it as UTF-8')]);
  assert.deepEqual(ids('unknown-team'), [], 'no UTF team, so never a ticket');
});

test('the yesterday digest includes sessions that also worked today', () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = todayStart - day / 2, today = todayStart + 60e3;
  scan('both-days', [user('Start the release', yesterday), user('Finish the release', today)]);
  const st = linearScans.get('both-days');
  st.story.recaps.push({ text: 'Release cut yesterday.', ts: yesterday }, { text: 'Release shipped today.', ts: today });
  const sessions = [{ sessionId: 'both-days', title: 'Release', phase: 'ended', lastTs: today }];
  const y = digest(sessions, 'yesterday');
  assert.deepEqual(y.unassigned, ['Release'], 'it worked yesterday, so it is in yesterday\'s digest');
  const t = digest(sessions, 'today');
  assert.deepEqual(t.unassigned, ['Release']);
  scan('only-today', [user('New thing', today)]);
  assert.deepEqual(digest([{ sessionId: 'only-today', title: 'New', lastTs: today }], 'yesterday').unassigned, [], 'nothing yesterday, so left out');
});
