// (Re)loading the always-on LaunchAgent. `launchctl bootout` returns while the old job is still
// shutting down (about a second for the server), and a bootstrap in that window fails with
// "Bootstrap failed: 5: Input/output error". So wait until the job is really gone, then bootstrap,
// retrying briefly in case launchd still holds on to it.
import { execFileSync } from 'node:child_process';

// Runs launchctl; never throws. Returns { ok, error } with launchctl's own message on failure.
export function launchctl(args) {
  try {
    execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).replace(/\s+/g, ' ').trim() };
  }
}

// Blocks this (short-lived CLI) process; setup runs synchronously.
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// writePlist runs between unloading the old job and loading the new one.
// Returns { ok: true } or { ok: false, error }.
export function reloadAgent({ uid, label, plist, writePlist, run = launchctl, sleep = sleepSync, unloadMs = 15000, pollMs = 100, tries = 5 }) {
  const target = `gui/${uid}/${label}`;
  const loaded = () => run(['print', target]).ok;
  if (loaded()) {
    run(['bootout', target]);
    for (let waited = 0; loaded(); waited += pollMs) {
      if (waited >= unloadMs) return { ok: false, error: `the running service did not stop within ${unloadMs / 1000} s` };
      sleep(pollMs);
    }
  }
  writePlist();
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    last = run(['bootstrap', `gui/${uid}`, plist]);
    if (last.ok) return { ok: true };
    if (attempt < tries) sleep(250 * attempt);
  }
  return { ok: false, error: last.error };
}
