// Small JSON files CC Mission Control keeps for itself, written so a crash or two
// writers at once can never leave half a file behind.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const dataDir = () => process.env.CCMC_DATA_DIR || path.join(os.homedir(), '.claude', 'cc-mission-control');

// Owner-only: the folder holds the access token, transcript-derived stories and pasted images.
export function ensureDataDir(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change; carry on */ }
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
