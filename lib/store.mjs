// Small JSON files CC Mission Control keeps for itself, written so a crash or two
// writers at once can never leave half a file behind.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const dataDir = () => process.env.CCMC_DATA_DIR || path.join(os.homedir(), '.claude', 'cc-mission-control');

// Owner-only: the folder holds the access token, transcript-derived stories and pasted images.
// A folder the user already had (CCMC_DATA_DIR) keeps its permissions; only one made here is tightened.
export function ensureDataDir(dir = dataDir()) {
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* umask already applied */ }
  return dir;
}

const tmpFor = (file) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

export function writeFileAtomicSync(file, data, mode = 0o600) {
  const tmp = tmpFor(file);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

export async function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = tmpFor(file);
  try {
    await fsp.writeFile(tmp, data, { mode });
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export const saveJson = (file, value) => writeFileAtomic(file, JSON.stringify(value));

// A missing file is normal (first run). A file that exists but can't be read as JSON is moved
// aside and reported, so the next save can't silently replace what was in it.
export function loadJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Could not read ${file}: ${e.message}`);
    return fallback;
  }
  try { return JSON.parse(raw); } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* leave it where it is */ }
    console.error(`${file} is not valid JSON (${e.message}); kept it as ${aside} and started fresh.`);
    return fallback;
  }
}

// The service's log only grows; at startup a log over `max` bytes keeps just its last `keep` bytes,
// from the start of a line. launchd appends to it, so trimming in place is safe.
export function trimLog(file, max = 5e6, keep = 1e6) {
  try {
    const { size } = fs.statSync(file);
    if (size <= max) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, size - keep);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    fs.truncateSync(file, 0);
    fs.appendFileSync(file, `[log trimmed at ${new Date().toISOString()}: kept the last ${Math.round(keep / 1e6)} MB]\n` + text.slice(text.indexOf('\n') + 1));
    return true;
  } catch { return false; }
}
