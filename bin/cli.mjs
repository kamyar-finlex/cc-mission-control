#!/usr/bin/env node
// cc-mission-control: start the dashboard, or set up / remove its optional pieces.
//   cc-mission-control                 start on http://localhost:7777 and open it, signed in
//   cc-mission-control open            open the running dashboard, signed in
//   cc-mission-control setup           always-on (macOS) + status line + skill + usage-task instructions
//                                      (--no-service skips the always-on service)
//   cc-mission-control uninstall       remove the always-on service
//   cc-mission-control usage-task      print the message that creates the usage task
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../lib/cli-args.mjs';
import { dataDir, ensureDataDir, writeFileAtomicSync } from '../lib/store.mjs';
import { loadOrCreateToken } from '../lib/auth.mjs';
import { planStatusLine } from '../lib/settings.mjs';
import { reloadAgent, launchctl } from '../lib/launchd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');
const STATUSLINE = path.join(ROOT, 'statusline.mjs');
const HOME = os.homedir();
const LABEL = 'com.cc-mission-control';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(HOME, 'Library', 'Logs', 'cc-mission-control.log');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const SKILL_SRC = path.join(ROOT, 'skills', 'project-updates');
const SKILL_DEST = path.join(HOME, '.claude', 'skills', 'project-updates');
const DATA_DIR = dataDir();

let parsed;
try { parsed = parseArgs(process.argv.slice(2), process.env); } catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}\n`);
  process.exit(2);
}
const { cmd, port } = parsed;
const flag = (name) => parsed.flags.has(name);
const isMac = process.platform === 'darwin';
const fromNpxCache = /[\\/]_npx[\\/]/.test(ROOT);

const say = (s = '') => process.stdout.write(`${s}\n`);
const quote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

// The sign-in link: the page turns the token into an HttpOnly cookie and drops it from the address bar.
const signInUrl = () => `http://localhost:${port}/?token=${loadOrCreateToken(DATA_DIR)}`;

function openBrowser(url) {
  const opener = isMac ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch { say(`Open ${url} in your browser.`); }
}

function start() {
  ensureDataDir(DATA_DIR);
  loadOrCreateToken(DATA_DIR); // before the server starts, so both use the same one
  const child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: { ...process.env, PORT: String(port) } });
  if (!flag('no-open')) setTimeout(() => openBrowser(signInUrl()), 1200);
  child.on('exit', (code) => process.exit(code ?? 0));
}

// What answers on this port: 'console', 'other' (some other server, or an older console), or 'none'.
// The token only ever goes to a server that identifies itself as the console.
const probe = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `localhost:${port}` }, timeout: 2000 }, (res) => {
    res.resume();
    resolve(res.headers['x-console'] === 'cc-mission-control' ? 'console' : 'other');
  });
  req.on('error', () => resolve('none'));
  req.on('timeout', () => { req.destroy(); resolve('none'); });
});

async function open() {
  const found = await probe();
  if (found === 'none') {
    say(`CC Mission Control isn't running on port ${port}. Start it with  cc-mission-control${port === 7777 ? '' : ` --port ${port}`}  (or  cc-mission-control setup  for the always-on service).`);
    process.exit(1);
  }
  if (found === 'other') {
    say(`Something on port ${port} isn't this version of CC Mission Control, so the sign-in link wasn't opened.`);
    say(`If it's an older CC Mission Control, restart it (for the always-on service: cc-mission-control setup).`);
    process.exit(1);
  }
  openBrowser(signInUrl());
  say(`Opened http://localhost:${port} in your browser, signed in.`);
}

function plist() {
  const pathVar = [path.dirname(process.execPath), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(process.execPath)}</string><string>${x(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${x(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x(pathVar)}</string>
    <key>HOME</key><string>${x(HOME)}</string>
    <key>PORT</key><string>${x(port)}</string>${process.env.CCMC_DATA_DIR ? `
    <key>CCMC_DATA_DIR</key><string>${x(process.env.CCMC_DATA_DIR)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${x(LOG)}</string>
  <key>StandardErrorPath</key><string>${x(LOG)}</string>
</dict>
</plist>
`;
}

function installService() {
  if (!isMac) { say('• Always-on service: macOS only for now. On Linux, run it from a systemd user unit or your session startup.'); return; }
  if (fromNpxCache) {
    say('• Always-on service: skipped. You ran this through npx, whose cache can be cleaned at any time.');
    say('  Install it for good first:  npm install -g cc-mission-control  &&  cc-mission-control setup');
    return;
  }
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const r = reloadAgent({ uid: process.getuid(), label: LABEL, plist: PLIST, writePlist: () => fs.writeFileSync(PLIST, plist()) });
  if (!r.ok) {
    say(`• Always-on service: written to ${PLIST}, but launchctl could not start it (${r.error}).`);
    say('  It starts at your next login. To start it now, run  cc-mission-control setup  again.');
    return;
  }
  say(`• Always-on service: installed. It starts at login, restarts if it dies, and serves http://localhost:${port}`);
  say(`  Logs: ${LOG}`);
}

function installStatusLine() {
  const command = `${quote(process.execPath)} ${quote(STATUSLINE)}`;
  if (fromNpxCache) { say('• Status line: skipped for an npx run (see above). Install globally, then run setup again.'); return; }
  let raw = null;
  try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') { say(`• Status line: skipped. Could not read ${SETTINGS} (${e.message}).`); return; }
  }
  const plan = planStatusLine(raw, command);
  if (plan.action === 'invalid') { say(`• Status line: skipped. ${SETTINGS} isn't valid JSON (${plan.error}), so it was left exactly as it is.`); return; }
  if (plan.action === 'current') { say('• Status line: already set up.'); return; }
  if (plan.action === 'foreign') {
    say('• Status line: you already have one, so it was left alone. To feed plan limits to the dashboard as well, have');
    say(`  your status line command pipe its input into:  ${command}`);
    return;
  }
  // Re-read just before writing: if Claude Code changed the file meanwhile, don't overwrite its change.
  let now = null;
  try { now = fs.readFileSync(SETTINGS, 'utf8'); } catch { /* still missing */ }
  if (now !== raw) { say('• Status line: skipped. settings.json changed while setup was running; run setup again.'); return; }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  // The backup holds settings from before CC Mission Control's first change; a later re-pin keeps it.
  const backup = `${SETTINGS}.bak-cc-mission-control`;
  if (raw !== null && !(plan.action === 'update' && fs.existsSync(backup))) fs.copyFileSync(SETTINGS, backup);
  writeFileAtomicSync(SETTINGS, plan.next, raw === null ? 0o600 : fs.statSync(SETTINGS).mode & 0o777);
  say(plan.action === 'update'
    ? '• Status line: updated to this copy and this Node.js (backup next to settings.json).'
    : '• Status line: added to ~/.claude/settings.json (backup next to it). Terminal Claude Code sessions now report plan limits.');
}

// The project-updates skill, so Claude can turn the day's sessions into project updates.
// An older copy is replaced (kept as SKILL.md.bak), so updates reach the installed skill.
function installSkill() {
  const src = path.join(SKILL_SRC, 'SKILL.md');
  const dest = path.join(SKILL_DEST, 'SKILL.md');
  const bundled = fs.readFileSync(src, 'utf8');
  let installed = null;
  try { installed = fs.readFileSync(dest, 'utf8'); } catch { /* not installed yet */ }
  if (installed === bundled) { say('• Project-updates skill: already up to date.'); return; }
  fs.mkdirSync(SKILL_DEST, { recursive: true });
  if (installed !== null) fs.copyFileSync(dest, `${dest}.bak`);
  writeFileAtomicSync(dest, bundled, 0o644);
  say(installed === null
    ? `• Project-updates skill: installed to ${SKILL_DEST}. New Claude Code sessions can run /project-updates.`
    : `• Project-updates skill: updated in ${SKILL_DEST} (the previous copy is SKILL.md.bak).`);
}

function usageTaskMessage() {
  const file = path.join(DATA_DIR, 'plan.json');
  return `Create a scheduled task with taskId "cc-mission-control-usage", title "CC Mission Control usage refresh", cron "*/30 * * * *", notifications off, and this prompt:

---
Keep the usage toolbar of the local CC Mission Control dashboard up to date. Do only this:
1. Call the tool mcp__ccd_session_mgmt__get_usage with no arguments (load it with ToolSearch "select:mcp__ccd_session_mgmt__get_usage" if needed).
2. If plan.status is "ok", overwrite ${file} with JSON {"plan": plan.plan, "windows": [{"label", "percentUsed", "resetsAt"} for each of plan.windows], "updatedAt": <now in Unix ms>}, using one python3 command.
3. Otherwise change nothing. Touch nothing else. End with one line of the saved percentages.
---`;
}

function setup() {
  say('Setting up CC Mission Control\n');
  if (flag('no-service')) say('• Always-on service: skipped (--no-service).'); else installService();
  installStatusLine();
  installSkill();
  ensureDataDir(DATA_DIR);
  loadOrCreateToken(DATA_DIR);
  say('\n• Usage toolbar (optional, Claude desktop app): the app keeps your usage card to itself, so a small scheduled task');
  say('  reads it every 30 minutes. Paste this into any Claude Code session in the Claude app:\n');
  say(usageTaskMessage().replace(/^/gm, '    '));
  say('\nOptional, when you want them:');
  say('  • PR states on cards: install the GitHub CLI and run  gh auth login');
  say('  • Ticket and project data: connect Linear to Claude (Claude app settings, Connectors)');
  say('  • Write/Check with Claude and background agents: run  claude  once in a terminal and log in');
  say('  • Send to agent (macOS): turn it on in the dashboard; it walks you through the Accessibility permission');
  say(`\nDone. Open it with:  cc-mission-control open${port === 7777 ? '' : ` --port ${port}`}`);
}

function uninstall() {
  if (isMac && fs.existsSync(PLIST)) {
    launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]); // fails harmlessly when it is already stopped
    fs.rmSync(PLIST);
    say('• Always-on service removed.');
  } else say('• No always-on service installed.');
  say('• Status line: remove "statusLine" from ~/.claude/settings.json if you no longer want it (a backup from setup may sit next to it).');
  say(`• Skill: delete ${SKILL_DEST} if you no longer want /project-updates.`);
  say(`• Saved data (archive list, stories, usage) is in ${DATA_DIR}; delete it if you like.`);
  say('• If you created the usage task in the Claude app, delete it from the app\'s Scheduled page.');
}

if (flag('help')) { say(USAGE); process.exit(0); }
if (flag('version')) { say(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version); process.exit(0); }

switch (cmd) {
  case 'start': start(); break;
  case 'open': await open(); break;
  case 'setup': setup(); break;
  case 'uninstall': uninstall(); break;
  case 'usage-task': say(usageTaskMessage()); break;
}
