#!/usr/bin/env node
// Claude Code statusLine command. Saves the plan limits Claude Code passes in
// (rate_limits) to ~/.claude/cc-mission-control/usage-statusline.json for CC Mission Control, and prints
// a short status line for the terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw); } catch { /* print nothing useful */ }

const limits = input.rate_limits;
if (limits && Object.keys(limits).length) {
  const dir = process.env.CCMC_DATA_DIR || path.join(os.homedir(), '.claude', 'cc-mission-control');
  const file = path.join(dir, 'usage-statusline.json');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...limits, updatedAt: Date.now(), sessionId: input.session_id }));
    fs.renameSync(tmp, file);
  } catch { /* the status line must still print */ }
}

const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : undefined);
const parts = [
  input.model?.display_name,
  pct(limits?.five_hour) && `5h ${pct(limits.five_hour)}`,
  pct(limits?.seven_day) && `week ${pct(limits.seven_day)}`,
  input.context_window?.used_percentage != null && `ctx ${Math.round(input.context_window.used_percentage)}%`,
].filter(Boolean);
process.stdout.write(parts.join(' · '));
