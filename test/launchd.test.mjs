import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadAgent } from '../lib/launchd.mjs';

const EIO = { ok: false, error: 'Bootstrap failed: 5: Input/output error' };

// A fake launchd that behaves like the real one: after bootout the job stays loaded for
// `unloadPolls` more `print` calls, and a bootstrap while it is still loaded fails with error 5.
function fakeLaunchd({ loaded = true, unloadPolls = 3, bootstrapFailures = 0 } = {}) {
  const calls = [];
  let state = loaded ? 'running' : 'gone';
  let polls = 0;
  let failures = bootstrapFailures;
  const run = (args) => {
    calls.push(args[0]);
    switch (args[0]) {
      case 'print':
        if (state === 'stopping' && ++polls > unloadPolls) state = 'gone';
        return state === 'gone' ? { ok: false, error: 'Could not find service' } : { ok: true };
      case 'bootout':
        if (state === 'gone') return { ok: false, error: 'Boot-out failed: 3: No such process' };
        state = 'stopping';
        return { ok: true };
      case 'bootstrap':
        if (state !== 'gone' || failures-- > 0) return EIO;
        state = 'running';
        return { ok: true };
      default:
        throw new Error(`unexpected launchctl ${args[0]}`);
    }
  };
  return { run, calls, state: () => state };
}

const opts = (fake, extra = {}) => {
  const slept = [];
  const written = [];
  return {
    slept, written,
    args: { uid: 501, label: 'com.cc-mission-control', plist: '/p.plist', writePlist: () => written.push(fake.state()), run: fake.run, sleep: (ms) => slept.push(ms), now: () => slept.reduce((a, b) => a + b, 0), ...extra },
  };
};

test('a running service is fully unloaded before the new one is bootstrapped', () => {
  const fake = fakeLaunchd({ unloadPolls: 3 });
  const o = opts(fake);
  assert.deepEqual(reloadAgent(o.args), { ok: true });
  assert.equal(fake.state(), 'running');
  assert.deepEqual(o.written, ['gone'], 'the plist is written once, after the old job is gone');
  assert.equal(fake.calls.filter((c) => c === 'bootstrap').length, 1, 'no error-5 bootstrap attempts');
  assert.equal(fake.calls.indexOf('bootstrap') > fake.calls.lastIndexOf('print'), true);
});

test('first install: nothing to unload, no bootout', () => {
  const fake = fakeLaunchd({ loaded: false });
  const o = opts(fake);
  assert.deepEqual(reloadAgent(o.args), { ok: true });
  assert.deepEqual(fake.calls, ['print', 'bootstrap']);
  assert.deepEqual(o.slept, []);
});

test('a bootstrap that still fails is retried with growing pauses', () => {
  const fake = fakeLaunchd({ loaded: false, bootstrapFailures: 2 });
  const o = opts(fake);
  assert.deepEqual(reloadAgent(o.args), { ok: true });
  assert.equal(fake.calls.filter((c) => c === 'bootstrap').length, 3);
  assert.deepEqual(o.slept, [250, 500]);
});

test('gives up with launchctl\'s own message after the last try', () => {
  const fake = fakeLaunchd({ loaded: false, bootstrapFailures: 99 });
  const o = opts(fake, { tries: 3 });
  assert.deepEqual(reloadAgent(o.args), { ...EIO, written: true });
  assert.equal(fake.calls.filter((c) => c === 'bootstrap').length, 3);
});

test('the unload deadline counts real time, not just pauses', () => {
  const fake = fakeLaunchd({ unloadPolls: Infinity });
  let clock = 0;
  const slowRun = (args) => { clock += 400; return fake.run(args); }; // each launchctl call takes 400 ms
  const o = opts(fake, { run: slowRun, now: () => clock, unloadMs: 2000, pollMs: 100 });
  assert.equal(reloadAgent(o.args).ok, false);
  assert.ok(clock < 3000, `gave up after ${clock} ms`);
});

test('a service that never stops is reported, not bootstrapped over', () => {
  const fake = fakeLaunchd({ unloadPolls: Infinity });
  const o = opts(fake, { unloadMs: 1000, pollMs: 100 });
  const r = reloadAgent(o.args);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not stop within 1 s/);
  assert.equal(r.written, false);
  assert.equal(fake.calls.includes('bootstrap'), false);
  assert.deepEqual(o.written, [], 'the plist is left as it was');
  assert.equal(o.slept.length, 10);
});
