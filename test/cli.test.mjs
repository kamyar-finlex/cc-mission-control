// setup and uninstall against a throwaway home, temp folder and service label, so the real
// ~/.claude and the real always-on service are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-cli-'));
const tmp = path.join(home, 'tmp');
fs.mkdirSync(tmp);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, CCMC_LAUNCHD_LABEL: `com.cc-mission-control.test-${process.pid}` };
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
const settings = path.join(home, '.claude', 'settings.json');
const skill = path.join(home, '.claude', 'skills', 'project-updates', 'SKILL.md');
const data = path.join(home, '.claude', 'cc-mission-control');

test('uninstall removes exactly what setup added, and keeps saved data unless --purge', () => {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash'] } }));
  cli('setup', '--no-service');
  assert.match(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, /statusline\.mjs"$/);
  assert.ok(fs.existsSync(skill));
  assert.ok(fs.existsSync(path.join(data, 'token')));
  const log = path.join(home, 'Library', 'Logs', 'cc-mission-control.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'x');
  fs.mkdirSync(path.join(tmp, 'cc-mission-control-tts'));

  const out = cli('uninstall');
  assert.match(out, /Removed: .*status line.*skill.*log.*speech cache/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { permissions: { allow: ['Bash'] } }, 'everything else stays');
  assert.ok(!fs.existsSync(path.dirname(skill)));
  assert.ok(!fs.existsSync(log));
  assert.ok(!fs.existsSync(path.join(tmp, 'cc-mission-control-tts')));
  assert.ok(fs.existsSync(path.join(data, 'token')), 'saved data stays');
  assert.match(out, /Kept: its saved data/);
  assert.doesNotMatch(out, /always-on service/, 'no service was installed, so none is reported');

  assert.match(cli('uninstall', '--purge'), /Removed: its saved data/);
  assert.ok(!fs.existsSync(data));
});

test('uninstall leaves a status line or skill the user changed', () => {
  cli('setup', '--no-service');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  s.statusLine.command = `bash ~/mine.sh | ${s.statusLine.command}`;
  fs.writeFileSync(settings, JSON.stringify(s));
  fs.appendFileSync(skill, '\nMy own note.\n');
  const out = cli('uninstall');
  assert.match(out, /Kept: your own status line/);
  assert.match(out, /Kept: the \/project-updates skill, which you changed/);
  assert.match(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, /mine\.sh/);
  assert.ok(fs.existsSync(skill));
});
