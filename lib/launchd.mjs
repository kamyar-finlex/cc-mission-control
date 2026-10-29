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
// Returns { ok: true }, or { ok: false, error, written } where `written` says whether the new plist was saved.
export function reloadAgent({ uid, label, plist, writePlist, run = launchctl, sleep = sleepSync, now = Date.now, unloadMs = 15000, pollMs = 100, tries = 5 }) {
  const target = `gui/${uid}/${label}`;
  const loaded = () => run(['print', target]).ok;
  if (loaded()) {
    run(['bootout', target]);
    const deadline = now() + unloadMs;
    while (loaded()) {
      if (now() >= deadline) return { ok: false, written: false, error: `the running service did not stop within ${unloadMs / 1000} s` };
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
  return { ok: false, written: true, error: last.error };
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The LaunchAgent. It restarts the server only after a crash: when the port is taken the server
// exits cleanly and stays stopped, instead of retrying (and logging) every few seconds.
export function plistXml({ label, node, server, root, port, home, log, pathVar, dataDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(server)}</string></array>
  <key>WorkingDirectory</key><string>${x(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x(pathVar)}</string>
    <key>HOME</key><string>${x(home)}</string>
    <key>PORT</key><string>${x(port)}</string>
    <key>CCMC_LOG</key><string>${x(log)}</string>${dataDir ? `
    <key>CCMC_DATA_DIR</key><string>${x(dataDir)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}
