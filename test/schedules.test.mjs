// Grouping a column's scheduled runs by schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRuns } from '../public/js/schedules.js';

const run = (id, task, phase = 'waiting', title) => ({ sessionId: id, phase, title: title || task, schedule: task && { id: task, family: task.replace(/-\d+$/, '') } });
const shape = (items) => items.map((x) => (x.type === 'card' ? x.s.sessionId : `${x.family}[${x.lead.sessionId}+${x.rest.map((r) => r.sessionId).join(',')}]`));

test('slots of one schedule become one group, in the newest run\'s place', () => {
  const col = [
    run('a1', 'autopilot-agent-2', 'waiting', 'Autopilot agent 2'),
    { sessionId: 'mine', phase: 'waiting', title: 'My session' },
    run('a2', 'autopilot-agent', 'waiting', 'Autopilot agent'),
    run('a3', 'autopilot-agent-3', 'waiting', 'Autopilot agent 3'),
  ];
  const out = groupRuns(col);
  assert.deepEqual(shape(out), ['autopilot-agent[a1+a2,a3]', 'mine']);
  assert.equal(out[0].name, 'Autopilot agent', 'named after the schedule, not the newest run');
  assert.equal(out[0].slots, 3);
});

test('working runs, lone runs and other schedules stay as they are', () => {
  const col = [
    run('w', 'autopilot-agent', 'working'),
    run('r1', 'receipts-autopilot'),
    run('a1', 'autopilot-agent'),
    run('a2', 'autopilot-agent'),
  ];
  assert.deepEqual(shape(groupRuns(col)), ['w', 'r1', 'autopilot-agent[a1+a2]']);
  assert.deepEqual(shape(groupRuns([run('only', 'autopilot-agent')])), ['only'], 'one run is just a card');
  assert.deepEqual(shape(groupRuns([{ sessionId: 'x', phase: 'ended' }, { sessionId: 'y', phase: 'ended' }])), ['x', 'y'], 'unscheduled sessions are never grouped');
});

test('the group counts its new runs and its slots', () => {
  const col = [run('a1', 'autopilot-agent'), run('a2', 'autopilot-agent-2'), run('a3', 'autopilot-agent-2')];
  const [g] = groupRuns(col, { isUnread: (s) => s.sessionId !== 'a2' });
  assert.equal(g.unread, 2);
  assert.equal(g.slots, 2);
  assert.equal(g.rest.length, 2);
});

test('a run that needs the user keeps its own card; the name comes from the schedule', () => {
  const asks = { ...run('q', 'autopilot-agent-2'), story: { waitingOn: { ask: 'Force-push?' } } };
  const col = [run('a1', 'autopilot-agent', 'waiting', 'Autopilot · SHA-132 renamed run'), asks, run('a2', 'autopilot-agent-3')];
  const needsYou = (s) => !!s.story?.waitingOn?.ask;
  const out = groupRuns(col, { standsOut: needsYou });
  assert.deepEqual(shape(out), ['autopilot-agent[a1+a2]', 'q']);
  assert.equal(out[0].name, 'Autopilot agent');
});
