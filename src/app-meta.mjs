import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { forEachLimit } from '../lib/limit.mjs';
import { APP_DIR } from './config.mjs';

// Claude desktop app metadata (read only).
// The app keeps one JSON per Code-tab session: its local_ id, archived flag and
// the session it was spawned from. Never written to: the app owns these files.

const APP_SESSIONS_DIR = path.join(APP_DIR, 'claude-code-sessions');
export const appMeta = new Map(); // cli sessionId -> { appId, parentAppId, archived, summary }
export const appIdToCli = new Map();
const appFileMtimes = new Map();
export const appFiles = new Map(); // app session id -> its metadata file

// The folder holds one file per app session (about 0.5 MB each, thousands of them), so files are
// read a few at a time, and only those that changed: the folder is watched where the platform
// allows, with a full check every minute in case an event is missed. Without a watch, every scan
// is a full check.
const FULL_SCAN_MS = 60e3;
const changed = new Set();
let watching = false;
let lastFull = 0;

function watchAppDir() {
  try {
    fs.watch(APP_SESSIONS_DIR, { recursive: true }, (_event, f) => {
      if (f && /(^|[\\/])local_[^\\/]*\.json$/.test(f)) changed.add(path.join(APP_SESSIONS_DIR, f));
    }).on('error', () => { watching = false; });
    watching = true;
  } catch { watching = false; }
}

async function listAppFiles() {
  const files = [];
  for (const a of await fsp.readdir(APP_SESSIONS_DIR))
    for (const o of await fsp.readdir(path.join(APP_SESSIONS_DIR, a)).catch(() => []))
      for (const f of await fsp.readdir(path.join(APP_SESSIONS_DIR, a, o)).catch(() => []))
        if (/^local_.*\.json$/.test(f)) files.push(path.join(APP_SESSIONS_DIR, a, o, f));
  return files;
}

async function readAppFile(file) {
  try {
    const st = await fsp.stat(file);
    if (appFileMtimes.get(file) === st.mtimeMs) return;
    appFileMtimes.set(file, st.mtimeMs);
    const m = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!m.cliSessionId || !m.sessionId) return;
    appIdToCli.set(m.sessionId, m.cliSessionId);
    appFiles.set(m.sessionId, file);
    appMeta.set(m.cliSessionId, {
      appId: m.sessionId, parentAppId: m.spawnedFrom?.sessionId, archived: !!m.isArchived,
      summary: m.postTurnSummary?.status_detail, needsAction: m.postTurnSummary?.needs_action || undefined,
      scheduledTaskId: m.scheduledTaskId, lastFocusedAt: m.lastFocusedAt || 0,
    });
  } catch { /* mid-write or removed; next scan */ }
}

export async function scanAppMeta() {
  let files;
  if (!watching || Date.now() - lastFull >= FULL_SCAN_MS) {
    if (!watching) watchAppDir(); // before listing, so a change during the listing is still seen
    changed.clear();
    try { files = await listAppFiles(); } catch { return; }
    lastFull = Date.now();
  } else {
    files = [...changed];
    changed.clear();
  }
  await forEachLimit(files, 8, readAppFile);
}
