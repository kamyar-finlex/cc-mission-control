import { execFile, spawn } from 'node:child_process';

// Running other programs: shell and AppleScript quoting, and child processes.

export const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const osa = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, out: (stdout + stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() }));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function pipeTo(cmd, input) {
  return new Promise((resolve) => {
    const c = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (b) => { o += b; });
    c.on('error', () => resolve({ ok: false, out: '' }));
    c.on('close', (code) => resolve({ ok: code === 0, out: o }));
    c.stdin.end(input ?? '');
  });
}
export const runOsa = (script, ...args) => new Promise((resolve) => {
  execFile('osascript', ['-e', script, ...args], { timeout: 60000 }, (err, stdout, stderr) => // the box search can take ~25s
    resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() }));
});
