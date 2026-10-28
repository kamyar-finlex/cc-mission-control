#!/usr/bin/env node
// cc-mission-control: start the dashboard, or set up / remove its optional pieces.
//   cc-mission-control                 start on http://localhost:7777 and open it
//   cc-mission-control setup           always-on (macOS) + status line + skill + usage-task instructions
//                                      (--no-service skips the always-on service)
//   cc-mission-control uninstall       remove the always-on service
//   cc-mission-control usage-task      print the message that creates the usage task
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const DATA_DIR = path.join(HOME, '.claude', 'cc-mission-control');

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(['--port']);
// The command is the first word that is neither an option nor an option's value.
const cmd = args.find((a, i) => !a.startsWith('-') && !VALUE_OPTS.has(args[i - 1])) || 'start';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const port = opt('port', process.env.PORT || '7777');
const isMac = process.platform === 'darwin';
const fromNpxCache = /[\\/]_npx[\\/]/.test(ROOT);

const say = (s = '') => process.stdout.write(`${s}\n`);
const quote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: { ...process.env, PORT: port } });
  if (!flag('no-open')) setTimeout(() => {
    const opener = isMac ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch { /* open it by hand */ }
  }, 1200);
  child.on('exit', (code) => process.exit(code ?? 0));
}

function plist() {
  const pathVar = [path.dirname(process.execPath), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
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
    <key>PORT</key><string>${x(port)}</string>
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
  const uid = process.getuid();
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
  fs.writeFileSync(PLIST, plist());
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  say(`• Always-on service: installed. It starts at login, restarts if it dies, and serves http://localhost:${port}`);
  say(`  Logs: ${LOG}`);
}

function installStatusLine() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* none yet */ }
  const command = `${quote(process.execPath)} ${quote(STATUSLINE)}`;
  if (settings.statusLine) {
    if (String(settings.statusLine.command || '').includes('statusline.mjs')) { say('• Status line: already set up.'); return; }
    say('• Status line: you already have one, so it was left alone. To feed plan limits to the dashboard as well, have');
    say(`  your status line command pipe its input into:  ${command}`);
    return;
  }
  if (fromNpxCache) { say('• Status line: skipped for an npx run (see above). Install globally, then run setup again.'); return; }
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-cc-mission-control`);
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify({ ...settings, statusLine: { type: 'command', command } }, null, 2)}\n`);
  say('• Status line: added to ~/.claude/settings.json (backup next to it). Terminal Claude Code sessions now report plan limits.');
}

// The project-updates skill, so Claude can turn the day's sessions into project updates.
function installSkill() {
  if (fs.existsSync(path.join(SKILL_DEST, 'SKILL.md'))) { say('• Project-updates skill: already installed (left as is).'); return; }
  fs.mkdirSync(SKILL_DEST, { recursive: true });
  fs.copyFileSync(path.join(SKILL_SRC, 'SKILL.md'), path.join(SKILL_DEST, 'SKILL.md'));
  say(`• Project-updates skill: installed to ${SKILL_DEST}. New Claude Code sessions can run /project-updates.`);
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  say('\n• Usage toolbar (optional, Claude desktop app): the app keeps your usage card to itself, so a small scheduled task');
  say('  reads it every 30 minutes. Paste this into any Claude Code session in the Claude app:\n');
  say(usageTaskMessage().replace(/^/gm, '    '));
  say('\nOptional, when you want them:');
  say('  • PR states on cards: install the GitHub CLI and run  gh auth login');
  say('  • Ticket and project data: connect Linear to Claude (Claude app settings, Connectors)');
  say('  • Write/Check with Claude and background agents: run  claude  once in a terminal and log in');
  say('  • Send to agent (macOS): turn it on in the dashboard; it walks you through the Accessibility permission');
  say('\nDone. Open http://localhost:' + port);
}

function uninstall() {
  if (isMac && fs.existsSync(PLIST)) {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* already stopped */ }
    fs.rmSync(PLIST);
    say('• Always-on service removed.');
  } else say('• No always-on service installed.');
  say('• Status line: remove "statusLine" from ~/.claude/settings.json if you no longer want it (a backup from setup may sit next to it).');
  say(`• Skill: delete ${SKILL_DEST} if you no longer want /project-updates.`);
  say(`• Saved data (archive list, stories, usage) is in ${DATA_DIR}; delete it if you like.`);
  say('• If you created the usage task in the Claude app, delete it from the app\'s Scheduled page.');
}

switch (cmd) {
  case 'start': start(); break;
  case 'setup': setup(); break;
  case 'uninstall': uninstall(); break;
  case 'usage-task': say(usageTaskMessage()); break;
  default:
    say('Usage: cc-mission-control [start|setup|uninstall|usage-task] [--port 7777] [--no-open] [--no-service]');
    process.exit(1);
}
