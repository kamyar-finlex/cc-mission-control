import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.mjs';

// The optional talking avatar: a local text-to-speech worker and the face's mouth bank.
// A talking face that reads replies aloud, all local: a mouth bank built once by avatar/bank_build.py
// and Kokoro speech from avatar/tts_worker.py. Off unless the bank exists.

export const AVATAR_DIR = process.env.CCMC_AVATAR_DIR || path.join(os.homedir(), '.local', 'share', 'presenter-film', 'avatar', 'clara');
const KOKORO_PY = process.env.CCMC_KOKORO_PYTHON || path.join(os.homedir(), '.local', 'share', 'presenter-film', 'venvs', 'kokoro', 'bin', 'python');
// Cached speech lives in the owner-only data folder (a shared temp folder would let other users plant
// files), and is pruned whenever the worker starts.
export const TTS_DIR = path.join(DATA_DIR, 'tts');
const TTS_KEEP_DAYS = 7;
const TTS_KEEP_FILES = 500;
let tts = null;

export function pruneSpeechCache(dir = TTS_DIR, now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(dir).map((f) => { const p = path.join(dir, f); return { p, f, t: fs.statSync(p).mtimeMs }; }); } catch { return 0; }
  const old = (x) => x.f.endsWith('.tmp.wav') || now - x.t > TTS_KEEP_DAYS * 864e5;
  const keep = files.filter((x) => !old(x)).sort((a, b) => b.t - a.t);
  const gone = [...files.filter(old), ...keep.slice(TTS_KEEP_FILES)];
  for (const x of gone) fs.rmSync(x.p, { force: true });
  return gone.length;
}

export function ttsWorker(voice = 'bf_emma') {
  if (tts) return tts;
  fs.mkdirSync(TTS_DIR, { recursive: true, mode: 0o700 });
  pruneSpeechCache();
  const child = spawn(KOKORO_PY, ['-I', path.join(ROOT, 'avatar', 'tts_worker.py'), voice], { stdio: ['pipe', 'pipe', 'pipe'] });
  // The worker's errors (a missing package, a model it can't load) go to this server's log, capped so a
  // broken install can't fill it.
  let logged = 0;
  let partial = '';
  child.stderr.on('data', (d) => {
    const lines = (partial + d).split('\n');
    partial = lines.pop(); // a line cut between two chunks waits for its end
    for (const line of lines) {
      if (!line.trim()) continue;
      if (logged < 200) console.error(`[voice] ${line}`);
      else if (logged === 200) console.error('[voice] (more output not logged)');
      logged++;
    }
  });
  const waiting = new Map();
  let buf = '';
  let ready;
  const w = { child, waiting, next: 1, alive: true, ready: new Promise((r) => { ready = r; }) };
  tts = w;
  // A worker that never says it is ready (stuck import, model fetch) is killed, so requests fail instead of hanging.
  const startup = setTimeout(() => child.kill(), 120000);
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { clearTimeout(startup); ready(); }
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const fail = () => {
    clearTimeout(startup);
    w.alive = false;
    for (const r of waiting.values()) r({ ok: false, error: 'the voice stopped' });
    waiting.clear();
    if (tts === w) tts = null;
    ready();
  };
  child.on('exit', fail);
  child.on('error', fail);
  child.stdin.on('error', () => { /* a dead worker's pipe: 'exit' reports it */ });
  return w;
}

export async function speakToFile(text, voice) {
  const key = crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex').slice(0, 20);
  const out = path.join(TTS_DIR, `${key}.wav`);
  if (fs.existsSync(out)) return { ok: true, out };
  const w = ttsWorker(voice);
  await w.ready;
  if (!w.alive) return { ok: false, error: 'the voice did not start' };
  const id = w.next++;
  const reply = new Promise((r) => {
    if (!w.alive) { r({ ok: false, error: 'the voice stopped' }); return; }
    w.waiting.set(id, r);
    setTimeout(() => { if (w.waiting.delete(id)) r({ ok: false, error: 'timed out' }); }, 60000);
  });
  w.child.stdin.write(JSON.stringify({ id, text, voice, out }) + '\n');
  const r = await reply;
  return r.ok ? { ok: true, out } : r;
}

export async function avatarManifest() {
  try {
    const file = path.join(AVATAR_DIR, 'manifest.json');
    // `version` changes whenever the bank is rebuilt; the page puts it on every image URL, so cached
    // images from an older bank are never paired with this manifest.
    const [text, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
    return { ...JSON.parse(text), version: Math.round(st.mtimeMs) };
  } catch { return null; }
}
