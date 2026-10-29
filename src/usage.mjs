import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, DATA_DIR } from './config.mjs';

// Usage.

// Written by statusline.mjs whenever a terminal Claude Code session redraws its status line.
const USAGE_FILE = path.join(DATA_DIR, 'usage-statusline.json');
const APP_USAGE_FILE = path.join(APP_DIR, 'plan-usage-history.json');
// The Claude app's usage card, saved by a Claude session's get_usage call
// (see README): { plan, windows: [{ label, percentUsed, resetsAt }], updatedAt }.
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');

// Every source becomes { plan, windows: [{ label, used, resetsAt (ms) }], updatedAt, source }; the newest wins.
export async function readPlanLimits() {
  const sources = [];
  try {
    const p = JSON.parse(await fsp.readFile(PLAN_FILE, 'utf8'));
    if (Array.isArray(p.windows)) sources.push({
      plan: p.plan, updatedAt: p.updatedAt, source: 'app',
      windows: p.windows.map((w) => ({ label: w.label, used: w.percentUsed, resetsAt: Date.parse(w.resetsAt) || undefined })),
    });
  } catch { /* not saved yet */ }
  try {
    const l = JSON.parse(await fsp.readFile(USAGE_FILE, 'utf8'));
    const win = (w, label) => w && typeof w.used_percentage === 'number' && { label, used: w.used_percentage, resetsAt: w.resets_at ? w.resets_at * 1000 : undefined };
    sources.push({ updatedAt: l.updatedAt, source: 'statusline', windows: [win(l.five_hour, '5-hour limit'), win(l.seven_day, 'Weekly · all models')].filter(Boolean) });
  } catch { /* not written yet */ }
  try {
    const last = JSON.parse(await fsp.readFile(APP_USAGE_FILE, 'utf8')).samples?.at(-1);
    if (last && Date.now() - last.t < 6 * 3600e3)
      sources.push({ updatedAt: last.t, source: 'app-history', windows: [{ label: '5-hour limit', used: last.u.fh }, { label: 'Weekly · all models', used: last.u.sd }] });
  } catch { /* app never sampled */ }
  return sources.filter((x) => x.windows.length).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
