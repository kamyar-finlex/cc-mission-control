// Notices put into a session by Claude Code or the app, as they appear in real transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNotices, onlyNotices, noticesHtml, noticeLine } from '../public/js/notices.js';
import { md } from '../public/js/markdown.js';

const TASK = `<task-notification>
<task-id>be98j6upt</task-id>
<tool-use-id>toolu_015PzefFaq9AxNV5pm5GHukL</tool-use-id>
<output-file>/private/tmp/claude-501/x/tasks/be98j6upt.output</output-file>
<status>completed</status>
<summary>Background command "Package the stage as a standalone Mac app with RunUAT" completed (exit code 0)</summary>
</task-notification>`;
const html = (text) => noticesHtml(splitNotices(text), md);

test('a finished background task becomes a card with its status, not tags', () => {
  const segs = splitNotices(TASK);
  assert.equal(onlyNotices(segs), true);
  const out = html(TASK);
  assert.doesNotMatch(out, /&lt;task-notification|&lt;task-id/);
  assert.match(out, /class="notice ntask t-ok"/);
  assert.match(out, /<span class="ntitle">Background command &quot;Package the stage as a standalone Mac app with RunUAT&quot; completed<\/span>/);
  assert.match(out, /<span class="nchip">completed · exit 0<\/span>/);
  assert.match(out, /<dt>Output<\/dt><dd>\/private\/tmp\/claude-501\/x\/tasks\/be98j6upt\.output<\/dd>/);
  assert.equal(noticeLine(TASK), 'Background command "Package the stage as a standalone Mac app with RunUAT" completed');
});

test('a failed task is marked as failed', () => {
  const out = html(TASK.replace('completed</status>', 'failed</status>').replace('(exit code 0)', '(exit code 2)'));
  assert.match(out, /class="notice ntask t-bad"/);
  assert.match(out, /failed · exit 2/);
  assert.match(html(TASK.replace('(exit code 0)', '(exit code 1)')), /t-bad/, 'a non-zero exit is a failure even when "completed"');
});

test('a scheduled run shows its name and folds its long instructions, even when cut off', () => {
  const run = '<scheduled-task name="autopilot-agent-3" file="/x/SKILL.md">\nThis is an automated run of a scheduled task. The user is not present…';
  const segs = splitNotices(run);
  assert.equal(segs[0].closed, false);
  const out = html(run);
  assert.match(out, /Scheduled run<\/span><span class="ntitle">autopilot-agent-3<\/span>/);
  assert.match(out, /<details class="nfold"><summary>Its instructions<\/summary>/);
  assert.match(out, /shortened in the transcript/);
  assert.equal(noticeLine(run), 'Scheduled run: autopilot-agent-3');
});

test('a slash command and a shell command each become one card', () => {
  const cmd = '<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>https://github.com/o/r/pull/46 --comment high</command-args>';
  assert.deepEqual(splitNotices(cmd), [{ type: 'command', name: '/code-review', args: 'https://github.com/o/r/pull/46 --comment high' }]);
  assert.match(html(cmd), /<code>\/code-review https:\/\/github\.com\/o\/r\/pull\/46 --comment high<\/code>/);
  assert.equal(noticeLine(cmd), '/code-review https://github.com/o/r/pull/46 --comment high');
  const sh = '<bash-input>git status</bash-input><bash-stdout>On branch main\nnothing to commit</bash-stdout><bash-stderr></bash-stderr>';
  assert.deepEqual(splitNotices(sh), [{ type: 'shell', input: 'git status', stdout: 'On branch main\nnothing to commit', stderr: '' }]);
  assert.match(html(sh), /<code>git status<\/code><\/div><pre class="npre ">On branch main\nnothing to commit<\/pre>/);
  const two = `${cmd}\n${cmd}`;
  assert.equal(splitNotices(two).length, 2, 'two commands in a row stay two cards');
});

test('what the user typed stays a bubble; pasted text (with a notice inside) is folded into it', () => {
  const msg = `do me a favor, can we show better UI for this\n\n<pasted_content id="3a71">\n${TASK}\n</pasted_content>`;
  const segs = splitNotices(msg);
  assert.equal(onlyNotices(segs), false);
  const out = html(msg);
  assert.match(out, /^<p>do me a favor, can we show better UI for this<\/p>/);
  assert.match(out, /class="notice npaste"><details class="nfold" open><summary>Pasted text \(7 lines\)<\/summary>/);
  assert.match(out, /class="notice ntask t-ok"/, 'the pasted notice is drawn as a card too');
  assert.equal(onlyNotices(splitNotices('<pasted_content id="1">just text</pasted_content>')), false, 'pasted text is the user\'s');
  // As Claude Code writes it: the closing tag repeats the id.
  const real = splitNotices('look\n<pasted_content id="3a71">\nhello\n</pasted_content id="3a71">\nthanks');
  assert.deepEqual(real.map((s) => [s.type, s.tag, s.closed]), [['text', undefined, undefined], ['notice', 'pasted_content', true], ['text', undefined, undefined]]);
  assert.doesNotMatch(html('<pasted_content id="3a71">hello</pasted_content id="3a71">'), /shortened/);
});

test('ordinary HTML in a message is not a notice; other dashed tags get a plain card', () => {
  assert.deepEqual(splitNotices('<b>bold</b> and <div>x</div>').map((s) => s.type), ['text']);
  const ev = '<ci-monitor-event>"Auto-fix" was just enabled for this session.</ci-monitor-event>';
  assert.match(html(ev), /class="notice ngeneric"><div class="nhead"><span class="nicon" aria-hidden="true">🔧<\/span><span class="nlabel">Ci monitor event<\/span>/);
  assert.match(html('<some-new-thing>{"a":1}</some-new-thing>'), /<pre class="npre ">\{&quot;a&quot;:1\}<\/pre>/);
  assert.equal(noticeLine('plain words, no notice'), 'plain words, no notice');
});

test('tags the user merely mentions stay part of their message', () => {
  const said = 'replace <my-button> with the new one, and also check the header';
  assert.deepEqual(splitNotices(said), [{ type: 'text', text: said }], 'an unclosed made-up tag is text');
  const asked = 'why does <task-notification> show as text? and `<scheduled-task>` too';
  assert.deepEqual(splitNotices(asked), [{ type: 'text', text: asked }], 'a notice named mid-sentence is text');
  const later = `${asked}\n${TASK}`;
  assert.deepEqual(splitNotices(later).map((s) => s.type), ['text', 'notice'], 'a real notice on its own line still counts');
});

test('nothing from a notice reaches the page unescaped', () => {
  const evil = '<task-notification><status>completed" onmouseover="x</status><summary><img src=x onerror=alert(1)></summary><output-file>"><script>1</script></output-file></task-notification>';
  const out = html(evil);
  assert.doesNotMatch(out, /<img|<script|onmouseover="x/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const name = html('<scheduled-task name="&quot;><b>x</b>">y</scheduled-task>');
  assert.doesNotMatch(name, /<b>x<\/b>/);
});
