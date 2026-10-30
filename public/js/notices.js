// Notices that Claude Code and the Claude app put into a session as tagged text (a background task
// finished, a scheduled run, a slash command, a shell command, pasted text...). They arrive as user
// messages, so they are split out here and drawn as cards instead of raw tags. No DOM: the server
// and the tests import this too.
import { esc } from './util.js';

// Tags known to carry notices, plus any tag with a dash or underscore in its name (new notices tend
// to look like that, and ordinary HTML in a message never does).
const KNOWN = 'task-notification|scheduled-task|ci-monitor-event|side-sessions-event|command-message|command-name|command-args|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|pasted_content|create-pr-command|artifact-view-context|agent-message|user-prompt-submit-hook';
// The closing tag may repeat the attributes (Claude Code ends pasted text with </pasted_content id="…">).
const BLOCK = new RegExp(`<(${KNOWN}|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)((?:\\s+[\\w-]+="[^"]*")*)\\s*>([\\s\\S]*?)(</\\1(?:\\s+[\\w-]+="[^"]*")*\\s*>|$)`, 'g');
const ATTR = /([\w-]+)="([^"]*)"/g;
const FIELD = /<([a-z][\w-]*)>([\s\S]*?)<\/\1>/g;

const attrsOf = (s) => Object.fromEntries([...(s || '').matchAll(ATTR)].map(([, k, v]) => [k, v]));
const fieldsOf = (body) => Object.fromEntries([...body.matchAll(FIELD)].map(([, k, v]) => [k, v.trim()]));

// [{ type: 'text', text } | { type: 'notice', tag, attrs, body, closed } | { type: 'command', name, args }
//  | { type: 'shell', input, stdout, stderr }]. A tag cut off by the transcript's length limit still
// becomes a notice (closed: false).
const KNOWN_TAG = new RegExp(`^(${KNOWN})$`);
export function splitNotices(text) {
  text = String(text ?? '');
  const out = [];
  let last = 0;
  const re = new RegExp(BLOCK.source, 'g');
  for (let m; (m = re.exec(text));) {
    // A real notice starts a line, or follows the previous one directly (<bash-input>…</bash-input><bash-stdout>);
    // a tag named mid-sentence or in inline code is the user's text. Only known notices may run to the end
    // unclosed (the transcript's length limit cut them); any other tag needs its closing tag.
    const atLineStart = /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, m.index - 200), m.index));
    if ((!atLineStart && m.index !== last) || (!m[4] && !KNOWN_TAG.test(m[1]))) { re.lastIndex = m.index + 1; continue; }
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'notice', tag: m[1], attrs: attrsOf(m[2]), body: m[3], closed: !!m[4] });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) out.push({ type: 'text', text: String(text).slice(last) });
  // Slash commands and shell commands arrive as several tags in a row: one card each.
  const merged = [];
  for (const s of out) {
    const prev = merged.at(-1);
    if (s.type === 'text' && !s.text.trim() && prev?.type !== 'text') continue; // whitespace between tags
    const part = s.type === 'notice' && /^(command-(message|name|args)|bash-(input|stdout|stderr))$/.test(s.tag) ? s.tag : null;
    if (part?.startsWith('command-')) {
      const cmd = prev?.type === 'command' && !prev[part] ? prev : (merged.push({ type: 'command' }), merged.at(-1));
      cmd[part] = s.body.trim();
    } else if (part?.startsWith('bash-')) {
      const sh = prev?.type === 'shell' && !prev[part] ? prev : (merged.push({ type: 'shell' }), merged.at(-1));
      sh[part] = s.body;
    } else merged.push(s);
  }
  return merged.map((s) => (s.type === 'command' ? { type: 'command', name: s['command-name'] || `/${s['command-message'] || ''}`, args: s['command-args'] || '' }
    : s.type === 'shell' ? { type: 'shell', input: s['bash-input'] || '', stdout: s['bash-stdout'] || '', stderr: s['bash-stderr'] || '' } : s));
}

// True when a message holds nothing the user typed or pasted: it is drawn as a notice, not a bubble.
export const onlyNotices = (segs) => segs.length > 0 && segs.every((s) => s.type !== 'text' || !s.text.trim()) && !segs.some((s) => s.tag === 'pasted_content');

const human = (tag) => tag.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const task = (s) => {
  const f = fieldsOf(s.body);
  const summary = (f.summary || s.body.replace(FIELD, '').trim()).replace(/\s+/g, ' ');
  const exit = summary.match(/\(exit code (-?\d+)\)/)?.[1];
  const status = (f.status || '').toLowerCase();
  return { f, status, exit, title: summary.replace(/\s*\(exit code -?\d+\)\s*$/, '') || 'Background task' };
};

// One plain line for places that show a message in a single line (a card's title or last message).
export function noticeLine(text) {
  const segs = splitNotices(text);
  if (!segs.some((s) => s.type !== 'text')) return text;
  return segs.map((s) => {
    if (s.type === 'text') return s.text.trim();
    if (s.type === 'command') return `${s.name} ${s.args}`.trim();
    if (s.type === 'shell') return `$ ${s.input.trim()}`;
    if (s.tag === 'task-notification') { const t = task(s); return t.title; }
    if (s.tag === 'scheduled-task') return `Scheduled run: ${s.attrs.name || 'task'}`;
    if (s.tag === 'pasted_content') return noticeLine(s.body).trim();
    return human(s.tag);
  }).filter(Boolean).join(' · ');
}

const fold = (summary, inner, open = false) => `<details class="nfold"${open ? ' open' : ''}><summary>${summary}</summary>${inner}</details>`;
const pre = (t, cls = '') => `<pre class="npre ${cls}">${esc(String(t).replace(/\n+$/, ''))}</pre>`;
const lines = (t) => String(t).split('\n').length;

// The HTML for a message: text through `md`, notices as cards. `md` is passed in (markdown.js), so
// this module stays free of the renderer's own imports.
export function noticesHtml(segs, md) {
  return segs.map((s) => {
    if (s.type === 'text') return s.text.trim() ? md(s.text) : '';
    if (s.type === 'command') {
      return `<div class="notice ncmd"><span class="nicon" aria-hidden="true">⌘</span><span class="nlabel">Command</span><code>${esc(`${s.name} ${s.args}`.trim())}</code></div>`;
    }
    if (s.type === 'shell') {
      const out = [s.stdout, s.stderr].filter((x) => x.trim()).join('\n');
      const body = out ? (lines(out) > 12 ? fold(`Output (${lines(out)} lines)`, pre(out, s.stderr.trim() ? 'err' : '')) : pre(out, s.stderr.trim() ? 'err' : '')) : '';
      return `<div class="notice nshell"><div class="nhead"><span class="nicon" aria-hidden="true">$</span><code>${esc(s.input.trim())}</code></div>${body}</div>`;
    }
    const { tag, body, attrs, closed } = s;
    const cut = closed ? '' : '<div class="ncut">(shortened in the transcript)</div>';
    if (tag === 'task-notification') {
      const t = task(s);
      const ok = t.status === 'completed' && (t.exit === undefined || t.exit === '0');
      const bad = /fail|error|killed|cancel/.test(t.status) || (t.exit !== undefined && t.exit !== '0');
      const tone = ok ? 'ok' : bad ? 'bad' : 'run';
      const chip = `${t.status ? esc(t.status) : 'update'}${t.exit !== undefined ? ` · exit ${esc(t.exit)}` : ''}`;
      const rows = [['Task', t.f['task-id']], ['Output', t.f['output-file']], ['Tool call', t.f['tool-use-id']], ['Result', t.f.result], ['Note', t.f.note], ['Usage', t.f.usage]]
        .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
      return `<div class="notice ntask t-${tone}"><div class="nhead"><span class="nicon" aria-hidden="true">${ok ? '✓' : bad ? '✗' : '⏳'}</span>`
        + `<span class="ntitle">${esc(t.title)}</span><span class="nchip">${chip}</span></div>${rows ? fold('Details', `<dl class="nrows">${rows}</dl>`) : ''}${cut}</div>`;
    }
    if (tag === 'scheduled-task') {
      return `<div class="notice nsched"><div class="nhead"><span class="nicon" aria-hidden="true">⏰</span><span class="nlabel">Scheduled run</span><span class="ntitle">${esc(attrs.name || 'task')}</span></div>`
        + `${fold('Its instructions', `<div class="nmd md">${md(body)}</div>`)}${cut}</div>`;
    }
    if (tag === 'pasted_content') {
      const inner = noticesHtml(splitNotices(body), md);
      const n = lines(body.trim()); // short pastes start open
      return `<div class="notice npaste">${fold(`Pasted text${n > 1 ? ` (${n} lines)` : ''}`, `<div class="nmd md">${inner}</div>`, n <= 8)}${cut}</div>`;
    }
    if (/^local-command-(stdout|stderr)$/.test(tag)) {
      return `<div class="notice nshell"><div class="nhead"><span class="nicon" aria-hidden="true">↳</span><span class="nlabel">Command output</span></div>${pre(body, tag.endsWith('stderr') ? 'err' : '')}</div>`;
    }
    const icon = { 'ci-monitor-event': '🔧', 'side-sessions-event': '↗', 'agent-message': '✉', 'artifact-view-context': '▣' }[tag] || 'ℹ';
    const inner = /^\s*[{[]/.test(body) ? pre(body) : `<div class="nmd md">${md(body)}</div>`;
    return `<div class="notice ngeneric"><div class="nhead"><span class="nicon" aria-hidden="true">${icon}</span><span class="nlabel">${esc(human(tag))}</span>`
      + `${attrs.name ? `<span class="ntitle">${esc(attrs.name)}</span>` : ''}</div>${body.trim() ? fold('Show', inner) : ''}${cut}</div>`;
  }).join('');
}
