import { PR_ICON, prClass, stClass } from './board.js';
import { $, action, setHtml, toast, ui } from './core.js';
import { runAction } from './drawer.js';
import { deliver } from './editor.js';
import { ago, esc } from './util.js';

// The "why is it still waiting" dialog: open items, who acts next, and suggested replies.

let whySid = null;
const GENERIC_REPLIES = [
  { label: 'Carry on with what is open', message: 'Carry on with the next open step from your last update. Tell me if you need anything from me.' },
  { label: 'What is left, and who owns it?', message: 'List everything still open in this session: what it is, who has to act (me, you or someone else), and what I should do next.' },
];
const WHO = { owner: 'you', session: 'the session', 'someone else': 'someone else' };

// Who has to act on an open item, which decides its group in the popup.
function whoActs(it) {
  if (it.kind === 'ticket') return it.statusType === 'started' || /progress|review/i.test(it.status || '') ? 'progress' : 'todo';
  if (it.kind === 'pr') return it.review === 'CHANGES_REQUESTED' || it.checks === 'FAILURE' ? 'you' : 'progress';
  if (it.who === 'owner') return 'you';
  if (it.who === 'someone else') return 'others';
  if (it.who === 'session') return 'notes';
  if (/needs? nothing from you|no action/i.test(it.text)) return 'notes';
  if (/\b(you|your)\b/i.test(it.text)) return 'you';
  if (/\bblock(ed|s)?\b|waits? (on|for)|awaiting/i.test(it.text)) return 'others';
  return 'notes';
}
const GROUPS = [['you', 'Needs you'], ['others', 'Waiting on someone else'], ['progress', 'In progress'], ['todo', 'Not started'], ['notes', 'Session notes']];
const WHO_LABEL = { owner: 'you', session: 'session', 'someone else': 'someone else' };

function whyRow(it, fromClaude) {
  if (it.kind === 'ticket') {
    const started = it.statusType === 'started' || /progress|review/i.test(it.status || '');
    return `<a class="wrow" href="${esc(it.url || '#')}" target="_blank" rel="noopener" title="${esc(it.text)}">
      <span class="wi"><span class="sdot ${stClass(it)}"></span></span><span class="wid">${esc(it.id)}</span>
      <span class="wt">${esc(it.title || '')}</span><span class="wst ${started ? 's-started' : ''}">${esc(it.status || '')}</span></a>`;
  }
  if (it.kind === 'pr') {
    const p = { state: it.prState || 'OPEN', isDraft: it.isDraft, review: it.review, checks: it.checks, number: it.number };
    const st = it.isDraft ? ['Draft', ''] : it.review === 'CHANGES_REQUESTED' ? ['Changes requested', 's-bad'] : it.checks === 'FAILURE' ? ['Checks failing', 's-bad']
      : it.review === 'APPROVED' ? ['Approved', 's-ok'] : ['Needs review', 's-started'];
    return `<a class="wrow" href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.text)}">
      <span class="wi"><span class="prchip ${prClass(p)}" style="padding:0 3px;border:0">${PR_ICON}</span></span><span class="wid">#${esc(it.number)}</span>
      <span class="wt">${esc(it.title || it.text)}</span><span class="wst ${st[1]}">${st[0]}</span></a>`;
  }
  const who = fromClaude && it.who ? `<span class="wst">${esc(WHO_LABEL[it.who] || it.who)}</span>` : '';
  const reply = it.reply ? `<button class="wreply" data-msg="${esc(it.reply)}" title="Sends: ${esc(it.reply)}">Reply</button>` : '';
  return `<div class="wrow"><span class="wi">•</span><span class="wt wrap">${esc(it.text)}</span>${who}${reply}</div>`;
}

function whyHtml(s) {
  const w = s.story?.waitingOn;
  const check = s.openCheck;
  const items = check ? check.items : s.openItems || [];
  const grouped = new Map(GROUPS.map(([k]) => [k, []]));
  for (const it of items) grouped.get(whoActs(it)).push(it);
  const n = (k) => grouped.get(k).length;

  // At a glance
  const chips = [];
  if (w?.ask) chips.push(`<span class="wchip c-ask">? 1 question for you</span>`);
  if (n('you')) chips.push(`<span class="wchip c-you">● ${n('you')} need${n('you') === 1 ? 's' : ''} you</span>`);
  if (n('others')) chips.push(`<span class="wchip">⛔ ${n('others')} waiting on others</span>`);
  if (n('progress')) chips.push(`<span class="wchip c-progress">◐ ${n('progress')} in progress</span>`);
  if (n('todo')) chips.push(`<span class="wchip">○ ${n('todo')} not started</span>`);
  if (!chips.length) chips.push(`<span class="wchip c-ok">✓ nothing open found</span>`);

  const parts = [`<div class="wstrip">${chips.join('')}</div>`];

  // The decision
  if (w?.ask) {
    const replies = w.actions || [];
    parts.push(`<div class="wdecide"><div class="whead"><span class="wkicker">Your decision</span>
        <span class="wbadge ${w.blocked ? 'block' : 'wait'}">${w.blocked ? 'Paused until you answer' : 'Can wait'}</span></div>
      <div class="wq">${esc(w.ask)}</div>
      ${replies.length ? `<div class="wbtns">${replies.map((a, i) => `<button class="${i === 0 ? 'primary' : ''}" data-msg="${esc(a.message || a.label)}">${esc(a.label)}</button>`).join('')}</div>
      <div class="wsend" id="wd-send">Sends: <b>${esc(replies[0].message || replies[0].label)}</b></div>` : ''}</div>`);
  } else {
    const headline = check?.done && !items.length ? 'Claude read the whole session and found nothing open.'
      : items.length ? (s.alive?.text || `${items.length} thing${items.length === 1 ? ' is' : 's are'} still open.`)
      : 'No question, and its notes show nothing open.';
    parts.push(`<div class="wdecide calm"><div class="whead"><span class="wkicker">No question for you</span></div><div class="wq" style="font-size:15px">${esc(headline)}</div>
      <div class="wbtns">${GENERIC_REPLIES.map((r, i) => `<button class="${i === 0 && items.length ? 'primary' : ''}" data-msg="${esc(r.message)}">${esc(r.label)}</button>`).join('')}</div>
      <div class="wsend" id="wd-send">Sends: <b>${esc(GENERIC_REPLIES[0].message)}</b></div></div>`);
  }

  // What is open, by who has to act
  for (const [k, label] of GROUPS) {
    const list = grouped.get(k); if (!list.length) continue;
    parts.push(`<div class="wgroup g-${k}"><div class="wgh">${label}<span class="n">${list.length}</span></div><div class="wlist">${list.map((it) => whyRow(it, !!check)).join('')}</div></div>`);
  }
  if (items.length) parts.push(`<div class="wsrc">${check ? `Checked by Claude ${ago(check.at)} ago${check.stale ? ' · there are newer turns, recheck' : ''}` : 'Found in its last two recaps, its Linear tickets and its PRs. ✦ Check with Claude reads the whole session.'}</div>`);

  // Context
  if (s.needsAction) parts.push(`<div class="wstand"><b>The Claude app says:</b> ${esc(s.needsAction)}</div>`);
  const ctx = w?.recap || s.summary || s.lastAssistant;
  if (ctx) parts.push(`<div class="wstand" id="wd-stand"><div class="wgh" style="margin-bottom:4px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:700">Where it stands</div><div class="wtx">${esc(ctx)}</div>${ctx.length > 220 ? '<button class="wmore" data-more>More</button>' : ''}</div>`);
  const how = s.appId ? 'Replies are copied and the session opens in the Claude app: paste and press Enter.'
    : !s.running ? 'Replies continue the session in the background.' : 'Replies are copied: paste them in its terminal.';
  parts.push(`<div class="wsrc">${how}</div>`);

  const checkBtn = checkingOpen.has(s.sessionId) ? '<button disabled>Checking…</button>'
    : `<button data-wact="check-open" title="Claude reads the whole session and lists what is still open">${check ? '↻ Recheck with Claude' : '✦ Check with Claude'}</button>`;
  const foot = [checkBtn, '<span style="flex:1"></span>', `<button data-wact="archive" title="When you're done with it">Archive</button>`, s.appId && `<button class="primary" data-wact="open-app">Open in Claude app</button>`].filter(Boolean).join('');
  return `<div class="wbody">${parts.join('')}</div><div class="wfoot">${foot}</div>`;
}
const checkingOpen = new Set();
export function renderWhy() {
  const s = ui.sessions.find((x) => x.sessionId === whySid); if (!s) return;
  $('wd-title').textContent = s.title;
  setHtml($('wd-body'), whyHtml(s));
}
export function openWhy(sid) { whySid = sid; renderWhy(); if (!$('whyDlg').open) $('whyDlg').showModal(); }
$('wd-close').onclick = () => $('whyDlg').close();
// Hovering a reply shows exactly what it would send.
$('whyDlg').addEventListener('mouseover', (e) => {
  const b = e.target.closest('.wbtns [data-msg]'); const out = $('wd-send');
  if (b && out) out.innerHTML = `Sends: <b>${esc(b.dataset.msg)}</b>`;
});
$('whyDlg').addEventListener('click', async (e) => {
  if (e.target === $('whyDlg')) { $('whyDlg').close(); return; }
  const s = ui.sessions.find((x) => x.sessionId === whySid); if (!s) return;
  if (e.target.closest('[data-more]')) { const b = $('wd-stand'); b.classList.toggle('open'); e.target.textContent = b.classList.contains('open') ? 'Less' : 'More'; return; }
  const act = e.target.closest('[data-wact]')?.dataset.wact;
  if (act === 'check-open') {
    checkingOpen.add(s.sessionId); renderWhy();
    toast('Claude is reading the session…', 4000);
    await action('check-open', { sessionId: s.sessionId });
    checkingOpen.delete(s.sessionId); renderWhy();
    return;
  }
  if (act) { $('whyDlg').close(); await runAction(act, s.sessionId); return; }
  const r = e.target.closest('[data-msg]'); if (!r) return;
  await sendReply(s, r.dataset.msg);
});

// The app's sessions can't be typed into from outside: copy the reply and jump there.
async function sendReply(s, text) {
  $('whyDlg').close();
  await deliver(s, text);
}
