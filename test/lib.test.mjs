import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchArgs, continueArgs } from '../lib/claude-args.mjs';
import { tokenMatches, readCookie, isAuthed, mayAct, cookieName, sessionCookie, loadOrCreateToken } from '../lib/auth.mjs';
import { planStatusLine, planRemoveStatusLine } from '../lib/settings.mjs';
import { parseArgs } from '../lib/cli-args.mjs';
import { loadJson, writeFileAtomicSync, ensureDataDir, trimLog } from '../lib/store.mjs';
import { plistXml } from '../lib/launchd.mjs';
import { forEachLimit } from '../lib/limit.mjs';

const TOKEN = 'a'.repeat(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-test-'));

test('user text always follows --, so it is never read as an option', () => {
  assert.deepEqual(continueArgs('abc', '- item'), ['--bg', '--resume', 'abc', '--', '- item']);
  assert.deepEqual(dispatchArgs({ prompt: '--version' }).args, ['--bg', '--', '--version']);
  assert.deepEqual(dispatchArgs({ prompt: 'hi', model: 'opus', permissionMode: 'plan' }).args,
    ['--bg', '--model', 'opus', '--permission-mode', 'plan', '--', 'hi']);
});

test('dispatch refuses permission modes that skip prompts, and option-shaped models', () => {
  for (const permissionMode of ['bypassPermissions', 'dontAsk', '--dangerously-skip-permissions', 'nope']) {
    assert.ok(dispatchArgs({ prompt: 'x', permissionMode }).error, permissionMode);
  }
  for (const model of ['--dangerously-skip-permissions', '-x', 'opus --x', '']) {
    const r = dispatchArgs({ prompt: 'x', model });
    if (model) assert.ok(r.error, model); else assert.ok(r.args);
  }
  for (const model of ['opus', 'fable', 'claude-opus-5-5', 'sonnet[1m]']) assert.ok(dispatchArgs({ prompt: 'x', model }).args, model);
});

test('token comparison and cookies', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches('b'.repeat(32), TOKEN), false);
  assert.equal(tokenMatches('short', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(readCookie(`x=1; ${cookieName(7777)}=${TOKEN}; y=2`, cookieName(7777)), TOKEN);
  assert.equal(readCookie(`${cookieName(7788)}=${TOKEN}`, cookieName(7777)), undefined);
  const c = sessionCookie(7777, TOKEN);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.match(c, new RegExp(part));
});

test('reads need the cookie or the header; actions also need proof they came from the page', () => {
  const cookie = `${cookieName(7777)}=${TOKEN}`;
  assert.equal(isAuthed({}, 7777, TOKEN), false);
  assert.equal(isAuthed({ cookie }, 7777, TOKEN), true);
  assert.equal(isAuthed({ 'x-console-token': TOKEN }, 7777, TOKEN), true);

  assert.equal(mayAct({ 'x-console-token': TOKEN }, 7777, TOKEN), true);
  assert.equal(mayAct({ cookie }, 7777, TOKEN), false, 'cookie alone is not enough');
  assert.equal(mayAct({ cookie, 'x-console-request': '1' }, 7777, TOKEN), true);
  assert.equal(mayAct({ cookie, 'x-console-request': '1', origin: 'http://localhost:7777' }, 7777, TOKEN), true);
  assert.equal(mayAct({ cookie, 'x-console-request': '1', origin: 'https://evil.example' }, 7777, TOKEN), false);
  assert.equal(mayAct({ 'x-console-request': '1' }, 7777, TOKEN), false);
});

test('the token file is created once, owner-only, and reused', () => {
  const dir = path.join(tmp(), 'data');
  const t1 = loadOrCreateToken(dir);
  assert.match(t1, /^[0-9a-f]{32}$/);
  assert.equal(loadOrCreateToken(dir), t1);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('status line: never rewrites a file it cannot parse, keeps everything else', () => {
  const cmd = '"/n/node" "/x/statusline.mjs"';
  assert.equal(planStatusLine('{"hooks": {}, }', cmd).action, 'invalid');
  assert.equal(planStatusLine('[]', cmd).action, 'invalid');
  assert.equal(planStatusLine('// comment\n{}', cmd).action, 'invalid');

  const add = planStatusLine('﻿{"permissions":{"allow":["Bash"]},"env":{"A":"1"}}', cmd);
  assert.equal(add.action, 'add');
  assert.deepEqual(JSON.parse(add.next), { permissions: { allow: ['Bash'] }, env: { A: '1' }, statusLine: { type: 'command', command: cmd } });

  assert.equal(planStatusLine(null, cmd).action, 'add');
  assert.equal(planStatusLine(JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/s.sh' } }), cmd).action, 'foreign');
  assert.equal(planStatusLine(JSON.stringify({ statusLine: { type: 'command', command: `bash ~/s.sh | ${cmd}` } }), cmd).action, 'foreign');
  assert.equal(planStatusLine(JSON.stringify({ statusLine: { type: 'command', command: cmd } }), cmd).action, 'current');

  const odd = '"/Users/a \\"b\\"/node" "/x/\\$y/statusline.mjs"';
  assert.equal(planStatusLine(JSON.stringify({ statusLine: { type: 'command', command: odd } }), cmd).action, 'update', 'escaped paths are still ours');

  const moved = planStatusLine(JSON.stringify({ statusLine: { type: 'command', command: '"/old/node" "/x/statusline.mjs"', padding: 1 } }), cmd);
  assert.equal(moved.action, 'update');
  assert.deepEqual(JSON.parse(moved.next).statusLine, { type: 'command', command: cmd, padding: 1 });
});

test('CLI arguments', () => {
  assert.deepEqual(parseArgs([]).cmd, 'start');
  assert.equal(parseArgs(['--port', '7788']).port, 7788);
  assert.equal(parseArgs(['--port=7788', 'open']).port, 7788);
  assert.equal(parseArgs(['open']).cmd, 'open');
  assert.equal(parseArgs([], { PORT: '7790' }).port, 7790);
  assert.ok(parseArgs(['-h']).flags.has('help'));
  assert.ok(parseArgs(['setup', '--no-service']).flags.has('no-service'));
  for (const bad of [['--port'], ['--port', '--no-open'], ['--port', '0'], ['--port', '99999'], ['--port', 'abc'],
    ['--no-sevice'], ['-x'], ['bogus'], ['open', 'setup']]) {
    assert.throws(() => parseArgs(bad), undefined, bad.join(' '));
  }
});

test('JSON stores: a broken file is moved aside, never silently overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'stories.json');
  assert.deepEqual(loadJson(file, {}), {});
  fs.writeFileSync(file, '{"a": 1');
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try { assert.deepEqual(loadJson(file, {}), {}); } finally { console.error = orig; }
  assert.equal(fs.existsSync(file), false);
  const aside = fs.readdirSync(dir).find((f) => f.startsWith('stories.json.corrupt-'));
  assert.ok(aside, 'the broken file is kept');
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{"a": 1');
  assert.equal(errors.length, 1);

  writeFileAtomicSync(file, '{"b":2}');
  assert.deepEqual(loadJson(file, {}), { b: 2 });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(fs.statSync(ensureDataDir(path.join(dir, 'd'))).mode & 0o777, 0o700);
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(shared, { mode: 0o755 });
  fs.chmodSync(shared, 0o755);
  ensureDataDir(shared);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755, 'an existing folder keeps its permissions');
});

test('forEachLimit: every item, never more than the limit at once', async () => {
  let inFlight = 0, peak = 0;
  const seen = [];
  await forEachLimit([...Array(25).keys()], 4, async (i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, (i * 7) % 5));
    seen.push(i); inFlight--;
  });
  assert.equal(peak, 4);
  assert.deepEqual(seen.sort((a, b) => a - b), [...Array(25).keys()]);
  await forEachLimit([], 8, () => { throw new Error('never called'); });
});

test('the service restarts only after a crash, logs to its log, and escapes every value', () => {
  const xml = plistXml({ label: 'com.x', node: '/n/node', server: '/a&b/server.mjs', root: '/a&b', port: 7777, home: '/h', log: '/h/l.log', pathVar: '/bin', dataDir: '/d<1>' });
  assert.match(xml, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(xml, /<key>CCMC_LOG<\/key><string>\/h\/l\.log<\/string>/);
  assert.match(xml, /\/a&amp;b\/server\.mjs/);
  assert.match(xml, /<key>CCMC_DATA_DIR<\/key><string>\/d&lt;1&gt;<\/string>/);
  assert.doesNotMatch(plistXml({ label: 'x', node: 'n', server: 's', root: 'r', port: 1, home: 'h', log: 'l', pathVar: 'p' }), /CCMC_DATA_DIR/);
});

test('trimLog keeps the last part of a big log, from a line start', () => {
  const file = path.join(tmp(), 'service.log');
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`).join('\n') + '\n';
  fs.writeFileSync(file, lines);
  assert.equal(trimLog(file, 1e9, 1000), false, 'small enough: untouched');
  assert.equal(trimLog(file, 10000, 5000), true);
  const kept = fs.readFileSync(file, 'utf8');
  assert.ok(kept.length < 5200);
  assert.match(kept, /^\[log trimmed at .*\]\nline \d{4} x+\n/);
  assert.match(kept, /line 1999 x+\n$/);
  assert.equal(trimLog(path.join(tmp(), 'missing.log')), false);
});

test('uninstall takes out only the status line setup wrote', () => {
  const ours = '"/n/node" "/x/statusline.mjs"';
  const r = planRemoveStatusLine(JSON.stringify({ env: { A: '1' }, statusLine: { type: 'command', command: ours } }));
  assert.equal(r.action, 'remove');
  assert.deepEqual(JSON.parse(r.next), { env: { A: '1' } });
  assert.equal(planRemoveStatusLine(JSON.stringify({ statusLine: { command: `bash a.sh | ${ours}` } })).action, 'foreign');
  assert.equal(planRemoveStatusLine(JSON.stringify({ env: {} })).action, 'none');
  assert.equal(planRemoveStatusLine(null).action, 'none');
  assert.equal(planRemoveStatusLine('{ broken').action, 'invalid');
});
