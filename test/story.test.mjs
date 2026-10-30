// The server's text logic, imported directly now that it lives in modules. These pin current
// behaviour, so a refactor that changes what a card says shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Importing the modules creates the data folder and token, so point them at a throwaway one first.
process.env.CCMC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-units-'));
const { stitch, openItemsFor, aliveReason, deployStage, deploysFor } = await import('../src/story.mjs');
const { toEvents, parseLines, summarize, projectOf, clip } = await import('../src/transcript.mjs');

const story = (recaps = [], asks = []) => ({ story: { recaps: recaps.map((text, i) => ({ text, ts: i })), asks: asks.map((text) => ({ text })), compacts: [] } });

test('stitch: the opening ask, a spread of recaps, and where it stands', () => {
  assert.equal(stitch(story().story, { lastAssistant: 'hi' }), 'Latest: hi');
  assert.equal(stitch(story().story, {}), '');
  assert.equal(stitch(story(['Fixed it. More detail.'], ['Fix the bug']).story),
    'It started with: “Fix the bug” Now: Fixed it. More detail.');
  assert.equal(stitch(story(['A one. x', 'B two. y', 'A one. z', 'Done now.'], ['Go']).story),
    'It started with: “Go” Along the way: A one. B two. Now: Done now.');
});

test('openItemsFor: open-sounding recap sentences, open PRs and unfinished tickets', () => {
  const s = {
    prs: [{ state: 'OPEN', number: 7, review: 'REVIEW_REQUIRED', checks: 'FAILURE' }, { state: 'MERGED', number: 6 }],
    linear: { tickets: [{ id: 'ABC-1', status: 'In Progress', statusType: 'started', title: 'Login' }, { id: 'ABC-2', status: 'Done', statusType: 'completed' }] },
  };
  const items = openItemsFor(s, story(['Shipped the fix. Nothing else to do.', 'Tests pass. Deploy is still pending on beta. All done here.']));
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [
    ['note', 'Deploy is still pending on beta.'],
    ['pr', 'PR #7 is open and needs a review; checks are failing.'],
    ['ticket', 'ABC-1 is In Progress: Login.'],
  ]);
});

test('aliveReason: the strongest reason, in order', () => {
  const reason = (s, items = []) => aliveReason(s, items);
  assert.equal(reason({ story: { waitingOn: { ask: 'Open the PR?' } } }).tone, 'ask');
  assert.deepEqual(reason({ prs: [{ state: 'OPEN', number: 3, review: 'CHANGES_REQUESTED' }] }), { tone: 'block', text: 'PR #3 has changes requested. I need you.' });
  assert.deepEqual(reason({ prs: [{ state: 'OPEN', number: 3, checks: 'ERROR' }] }), { tone: 'block', text: "PR #3 has failing checks. Don't forget me." });
  assert.deepEqual(reason({ prs: [{ state: 'OPEN', number: 3, review: 'APPROVED' }] }), { tone: 'ship', text: 'PR #3 is approved. Merge me.' });
  assert.equal(reason({ prs: [{ state: 'OPEN', number: 3, isDraft: true }] }).tone, 'done', 'a draft alone keeps nothing alive');
  assert.deepEqual(reason({}, [{ kind: 'note', text: 'This waits on the API team.' }]), { tone: 'block', text: 'Blocked: This waits on the API team.' });
  assert.deepEqual(reason({}, [{ kind: 'note', text: 'Waiting on the API team.' }]), { tone: 'block', text: 'Blocked: Waiting on the API team.' });
  assert.deepEqual(reason({}, [{ kind: 'note', text: 'Still waiting for CI to finish.' }]).tone, 'block');
  assert.deepEqual(reason({}, [{ kind: 'note', text: 'Needs a deploy to prod.' }]), { tone: 'ship', text: 'Not shipped yet: Needs a deploy to prod.' });
  assert.deepEqual(reason({}, [{ kind: 'note', text: 'The fix is not verified.' }]), { tone: 'wip', text: 'Not verified yet: The fix is not verified.' });
  assert.deepEqual(reason({ linear: { tickets: [{ id: 'A-1', status: 'In Review', statusType: 'started' }] } }), { tone: 'wip', text: "A-1 is still In Review. Don't archive me." });
  assert.deepEqual(reason({ linear: { tickets: [{ id: 'A-1', status: 'Todo', statusType: 'unstarted' }] } }), { tone: 'wip', text: 'A-1 is Todo. Someone has to pick it up.' });
  assert.deepEqual(reason({}), { tone: 'done', text: 'Nothing open that I can see. Safe to archive.' });
});

test('deployStage reads the wording of one sentence', () => {
  const cases = {
    'Production for api-server 2.4.0 still waits at the gate.': 'gate',
    'web-app 1.8.25 is on beta.': 'beta',
    'web-app 1.8.25 is live in production.': 'prod',
    'web-app 1.8.25 is not in production yet.': undefined,
    'web-app 1.8.25 is not on beta yet.': 'tagged',
    'web-app 1.8.25 is ready to tag.': 'ready',
    'Tagged web-app 1.8.25.': 'tagged',
    'Benchmarked web-app 1.8.25 against 1.8.24.': undefined,
  };
  for (const [t, stage] of Object.entries(cases)) assert.equal(deployStage(t), stage, t);
});

test('deploysFor: newest version per repository, bare versions join their family, least shipped first', () => {
  const d = deploysFor(story([
    'web-app 1.8.24 is in production.',
    'web-app 1.8.25 is on beta. Production for api-server 2.4.0 still waits at the gate.',
    'Also 1.8.25 benchmarks ran.',
    'web-app 1.8.23 is in production.',
  ]));
  assert.deepEqual(d.map((x) => [x.repo, x.version, x.stage, x.label]), [
    ['api-server', '2.4.0', 'gate', 'Waiting at the production gate'],
    ['web-app', '1.8.25', 'beta', 'On beta, not in production'],
  ]);
  assert.equal(d[1].evidence, 'web-app 1.8.25 is on beta.');
  assert.deepEqual(deploysFor(story(['web-app 1.8.25 is on beta.', 'Now 1.8.26 is in production.'])).map((x) => [x.repo, x.version, x.stage]),
    [['web-app', '1.8.26', 'prod']], 'a bare version joins the repository last named on its major.minor');
});

test('toEvents: what each kind of transcript line becomes', () => {
  const ts = '2026-10-29T10:00:00.000Z';
  assert.deepEqual(toEvents({ type: 'user', timestamp: ts, message: { content: 'Hello' }, cwd: '/w', gitBranch: 'main' }),
    [{ kind: 'user', text: 'Hello', ts: Date.parse(ts) }, { kind: 'branch', text: 'main' }, { kind: 'cwd', text: '/w' }]);
  assert.deepEqual(toEvents({ type: 'user', isSidechain: true, message: { content: 'x' } }), []);
  assert.deepEqual(toEvents({ type: 'user', isMeta: true, message: { content: 'x' } }), []);
  assert.deepEqual(toEvents({ type: 'user', gitBranch: 'HEAD', message: { content: '' } }), [], 'detached HEAD is not a branch');
  const a = toEvents({ type: 'assistant', timestamp: ts, message: { model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }, content: [
    { type: 'text', text: 'Done.' }, { type: 'text', text: '  ' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } });
  assert.deepEqual(a.map((e) => [e.kind, e.ctx, e.model]), [['assistant', 6, 'm'], ['tool', 6, 'm']]);
  assert.equal(a[1].id, 't1');
  assert.deepEqual(toEvents({ type: 'custom-title', customTitle: 'My title' }), [{ kind: 'title', text: 'My title' }]);
  const r = toEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } });
  assert.deepEqual(r.map((e) => [e.kind, e.text, e.error, e.id]), [['result', 'boom', true, 't1']]);
});

test('parseLines skips partial and non-JSON lines; summarize keeps the latest of each', () => {
  const text = [
    JSON.stringify({ type: 'custom-title', customTitle: 'T' }),
    'not json',
    JSON.stringify({ type: 'user', timestamp: '2026-10-29T10:00:00Z', message: { content: 'first ask' }, cwd: '/w' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-29T10:01:00Z', message: { model: 'claude-x', content: [{ type: 'text', text: 'answer' }] } }),
    '{"type":"user","message":{"content":"cut off',
  ].join('\n');
  const s = summarize(parseLines(text));
  assert.equal(s.title, 'T');
  assert.equal(s.cwd, '/w');
  assert.equal(s.firstUser, 'first ask');
  assert.equal(s.lastAssistant, 'answer');
  assert.equal(s.model, 'claude-x');
  assert.equal(s.lastKind, 'assistant');
  assert.equal(s.lastTs, Date.parse('2026-10-29T10:01:00Z'));
});

test('projectOf names worktrees after their repository', () => {
  assert.deepEqual(projectOf('/Users/a/src/app/.claude/worktrees/fix-x/sub'), { project: 'app', worktree: 'fix-x' });
  assert.deepEqual(projectOf('/Users/a/src/app'), { project: 'app' });
  assert.equal(clip('abcdef', 3), 'abc…');
});
