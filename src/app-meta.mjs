import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR } from './config.mjs';

// Claude desktop app metadata (read only).
// The app keeps one JSON per Code-tab session: its local_ id, archived flag and
// the session it was spawned from. Never written to: the app owns these files.

const APP_SESSIONS_DIR = path.join(APP_DIR, 'claude-code-sessions');
export const appMeta = new Map(); // cli sessionId -> { appId, parentAppId, archived, summary }
export const appIdToCli = new Map();
const appFileMtimes = new Map();
export const appFiles = new Map(); // app session id -> its metadata file

export async function scanAppMeta() {
  const files = [];
  try {
    for (const a of await fsp.readdir(APP_SESSIONS_DIR))
      for (const o of await fsp.readdir(path.join(APP_SESSIONS_DIR, a)).catch(() => []))
        for (const f of await fsp.readdir(path.join(APP_SESSIONS_DIR, a, o)).catch(() => []))
          if (/^local_.*\.json$/.test(f)) files.push(path.join(APP_SESSIONS_DIR, a, o, f));
  } catch { return; }
  await Promise.all(files.map(async (file) => {
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
    } catch { /* mid-write; next scan */ }
  }));
}
