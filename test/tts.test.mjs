// The avatar's voice worker, run for real (avatar/tts_worker.py) against small stand-ins for kokoro,
// numpy and soundfile: no model, but the same protocol, start-up and error paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-tts-'));
const stubs = path.join(root, 'stubs');
fs.mkdirSync(path.join(stubs, 'kokoro'), { recursive: true });
// A model that takes 0.8 s to load and, like real libraries, prints to stdout while it does.
fs.writeFileSync(path.join(stubs, 'kokoro', '__init__.py'), `
import sys, time
class KPipeline:
    def __init__(self, lang_code, repo_id):
        print("Loading voice model for", lang_code)
        time.sleep(0.8)
    def __call__(self, text, voice):
        if text == "boom":
            print("about to fail", file=sys.stderr)
            raise RuntimeError("cannot say that")
        yield None, None, [0.0, 0.5]
`);
fs.writeFileSync(path.join(stubs, 'numpy.py'), 'def asarray(a): return list(a)\ndef concatenate(xs): return [v for x in xs for v in x]\ndef clip(a, lo, hi): return a\n');
fs.writeFileSync(path.join(stubs, 'soundfile.py'), 'def write(path, data, rate):\n    open(path, "wb").write(b"RIFF" + bytes(len(data)))\n');
// The server runs `<python> -I tts_worker.py <voice>`; -I would ignore PYTHONPATH, so this stand-in drops it.
const python = path.join(root, 'python');
fs.writeFileSync(python, `#!/bin/sh\nshift\nPYTHONPATH="${stubs}" exec python3 "$@"\n`, { mode: 0o755 });

process.env.CCMC_DATA_DIR = path.join(root, 'data');
process.env.CCMC_KOKORO_PYTHON = python;
process.env.PRESENTER_FILM_HOME = path.join(root, 'none'); // no bundled espeak data to load
const { ttsWorker, speakToFile, pruneSpeechCache, TTS_DIR } = await import('../src/avatar.mjs');

const logged = [];
const origError = console.error;
console.error = (...a) => logged.push(a.join(' '));
test.after(() => { console.error = origError; ttsWorker().child.kill(); });

test('the worker says ready only once the voice is loaded, and stray prints do not break it', async () => {
  const t0 = Date.now();
  const w = ttsWorker('bf_emma');
  await w.ready;
  assert.equal(w.alive, true);
  assert.ok(Date.now() - t0 >= 700, `ready after ${Date.now() - t0} ms, before the model loaded`);
  const t1 = Date.now();
  const r = await speakToFile('Hello there', 'bf_emma');
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.readFileSync(r.out).subarray(0, 4).equals(Buffer.from('RIFF')));
  assert.ok(Date.now() - t1 < 700, 'the first request did not pay for loading the model');
  assert.ok(logged.some((l) => l === '[voice] Loading voice model for b'), 'library output went to the log');
});

test('an error is reported for that request and logged; the voice keeps working', async () => {
  const bad = await speakToFile('boom', 'bf_emma');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /RuntimeError: cannot say that/);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(logged.includes('[voice] about to fail'));
  assert.equal((await speakToFile('Still here', 'bf_emma')).ok, true);
});

test('the speech cache drops old, unfinished and surplus files', () => {
  const dir = path.join(root, 'cache');
  fs.mkdirSync(dir);
  const now = Date.now();
  const make = (f, ageDays) => { const p = path.join(dir, f); fs.writeFileSync(p, 'x'); const t = (now - ageDays * 864e5) / 1000; fs.utimesSync(p, t, t); };
  make('old.wav', 8);
  make('half.tmp.wav', 0);
  for (let i = 0; i < 502; i++) make(`n${String(i).padStart(3, '0')}.wav`, i / 1000);
  assert.equal(pruneSpeechCache(dir, now), 4);
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 500);
  assert.ok(!left.includes('old.wav') && !left.includes('half.tmp.wav'));
  assert.ok(left.includes('n000.wav') && !left.includes('n501.wav'), 'the newest are kept');
  assert.equal(path.dirname(TTS_DIR), process.env.CCMC_DATA_DIR, 'the cache lives in the owner-only data folder');
});
