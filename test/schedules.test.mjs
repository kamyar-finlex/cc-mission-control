// Grouping a column's scheduled runs by schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRuns, isQuietRun } from '../public/js/schedules.js';

const run = (id, task, phase = 'waiting', title) => ({ sessionId: id, phase, title: title || task, schedule: task && { id: task, family: task.replace(/-\d+$/, '') } });
const shape = (items) => items.map((x) => (x.type === 'card' ? x.s.sessionId : `${x.family}[${x.lead.sessionId}+${x.rest.map((r) => r.sessionId).join(',')}]`));

test('slots of one schedule become one group, in the newest run\'s place', () => {
  const col = [
    run('a1', 'nightly-report-2', 'waiting', 'Nightly report 2'),
    { sessionId: 'mine', phase: 'waiting', title: 'My session' },
    run('a2', 'nightly-report', 'waiting', 'Nightly report'),
    run('a3', 'nightly-report-3', 'waiting', 'Nightly report 3'),
  ];
  const out = groupRuns(col);
  assert.deepEqual(shape(out), ['nightly-report[a1+a2,a3]', 'mine']);
  assert.equal(out[0].name, 'Nightly report', 'named after the schedule, not the newest run');
  assert.equal(out[0].slots, 3);
});

test('working runs, lone runs and other schedules stay as they are', () => {
  const col = [
    run('w', 'nightly-report', 'working'),
    run('r1', 'inbox-triage'),
    run('a1', 'nightly-report'),
    run('a2', 'nightly-report'),
  ];
  assert.deepEqual(shape(groupRuns(col)), ['w', 'r1', 'nightly-report[a1+a2]']);
  assert.deepEqual(shape(groupRuns([run('only', 'nightly-report')])), ['only'], 'one run is just a card');
  assert.deepEqual(shape(groupRuns([{ sessionId: 'x', phase: 'ended' }, { sessionId: 'y', phase: 'ended' }])), ['x', 'y'], 'unscheduled sessions are never grouped');
});

test('the group counts its new runs and its slots', () => {
  const col = [run('a1', 'nightly-report'), run('a2', 'nightly-report-2'), run('a3', 'nightly-report-2')];
  const [g] = groupRuns(col, { isUnread: (s) => s.sessionId !== 'a2' });
  assert.equal(g.unread, 2);
  assert.equal(g.slots, 2);
  assert.equal(g.rest.length, 2);
});

test('a run that needs the user keeps its own card; the name comes from the schedule', () => {
  const asks = { ...run('q', 'nightly-report-2'), story: { waitingOn: { ask: 'Force-push?' } } };
  const col = [run('a1', 'nightly-report', 'waiting', 'Nightly report · renamed by hand'), asks, run('a2', 'nightly-report-3')];
  const needsYou = (s) => !!s.story?.waitingOn?.ask;
  const out = groupRuns(col, { standsOut: needsYou });
  assert.deepEqual(shape(out), ['nightly-report[a1+a2]', 'q']);
  assert.equal(out[0].name, 'Nightly report');
});

const said = (summary, extra = {}) => ({ sessionId: 'x', phase: 'waiting', title: 'Run', schedule: { id: 'nightly-report', family: 'nightly-report' }, summary, alive: { tone: 'done' }, ...extra });

test('a scheduled run that says it had nothing to do is quiet, whatever the schedule', () => {
  for (const t of ['nightly-report run skipped; nothing to process', 'Scheduled run ended with SKIP-EMPTY', 'No changes since yesterday.',
    'Inbox check: nothing new', 'All clear: every service healthy', 'Queue is empty, nothing to do', 'Everything is up to date']) {
    assert.equal(isQuietRun(said(t)), true, t);
  }
});

test('failures, real work, questions and unscheduled sessions are never quiet', () => {
  for (const t of ['keep-alive failed: browser not connected', "You've hit your monthly spend limit", "Can't run: the project has no config",
    'Skipped because of an error reading the queue', 'Deployed the fix to staging', '']) {
    assert.equal(isQuietRun(said(t)), false, t || '(nothing said)');
  }
  assert.equal(isQuietRun(said('skipped', { prs: [{ number: 1 }] })), false, 'touched a PR');
  assert.equal(isQuietRun(said('skipped', { linear: { tickets: [{ id: 'ABC-1' }] } })), false, 'touched a ticket');
  assert.equal(isQuietRun(said('skipped', { alive: { tone: 'wip' } })), false, 'something still open');
  assert.equal(isQuietRun(said('skipped', { story: { waitingOn: { ask: 'Retry?' } } })), false, 'asks something');
  assert.equal(isQuietRun(said('skipped', { phase: 'working' })), false, 'still working');
  assert.equal(isQuietRun(said('skipped', { schedule: undefined })), false, 'not a scheduled run');
  assert.equal(isQuietRun(said('', { lastAssistant: 'Nothing to do today.' })), true, 'reads the last reply when there is no summary');
});
