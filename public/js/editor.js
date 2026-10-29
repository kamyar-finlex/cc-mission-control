import { $, ACT_HEADERS, action, staleToken, store, toast, ui } from './core.js';
import { renderSendBtn, showAutoStatus } from './keys.js';
import { md } from './markdown.js';
import { esc } from './util.js';

// The Markdown editor (drawer, quick reply, new session), image attachments, and how replies are delivered.

export const drafts = {
  get: (k) => store.get(`draft:${k}`, ''),
  set: (k, v) => { if (v) store.set(`draft:${k}`, v); else try { localStorage.removeItem(`draft:${k}`); } catch {} },
};
const MD_TOOLS = [['attach', '📎', 'Attach an image (or paste / drop one)'], ['bold', '<b>B</b>', 'Bold (⌘B)'], ['italic', '<i>I</i>', 'Italic (⌘I)'], ['code', '&lt;/&gt;', 'Inline code'], ['link', '🔗', 'Link (⌘K)'],
  ['ul', '•', 'Bulleted list'], ['ol', '1.', 'Numbered list'], ['quote', '❝', 'Quote'], ['block', '{ }', 'Code block']];

export function editorHtml(key, { placeholder = 'Write in Markdown…', send = 'Send', cancel, hint = '', agentSwitch = false }) {
  return `<div class="mde" data-mde="${esc(key)}">
    <div class="mde-bar"><div class="mde-tabs"><button type="button" data-tab="write" class="on">Write</button><button type="button" data-tab="preview">Preview</button></div>
      <div class="mde-tools">${MD_TOOLS.map(([k, l, t]) => `<button type="button" data-md="${k}" title="${t}">${l}</button>`).join('')}</div></div>
    <textarea class="mde-in" placeholder="${esc(placeholder)}">${esc(drafts.get(key))}</textarea>
    <div class="mde-prev md" hidden></div>
    <div class="mde-att">${attStrip(drafts.get(key))}</div>
    <div class="mde-foot"><span class="mde-hint">${esc(hint)}</span><span style="flex:1"></span>${agentSwitch ? `<label class="mde-switch" title="Paste and press Enter in the Claude app for you"><input type="checkbox" data-agent-switch ${ui.autoSend ? 'checked' : ''}> Send to agent</label>` : ''}${cancel ? `<button type="button" class="mde-cancel">${esc(cancel)}</button>` : ''}<button type="button" class="primary mde-send" title="⌘↩">${esc(send)}</button></div>
  </div>`;
}

// Pasted images live as Markdown image links to local attachments; on send they become file paths Claude can open.
let attPaths = store.get('attPaths', {});
const ATT_RE = /!\[[^\]\n]*\]\(\/api\/attachments\/([\w.-]+)\)/g;
const attStrip = (text) => [...String(text || '').matchAll(ATT_RE)].map(([, name]) =>
  `<span class="att"><img src="/api/attachments/${esc(name)}" alt="attached image"><button type="button" data-rm="${esc(name)}" title="Remove">✕</button></span>`).join('');
export function expandAttachments(text) {
  const files = [];
  const out = text.replace(ATT_RE, (_, name) => { files.push(name); return `[Image: ${attPaths[name] || name}]`; });
  return { text: out, files };
}
async function attachFiles(m, files) {
  const ta = m.querySelector('.mde-in');
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast('Only PNG, JPEG, GIF or WebP images can be attached'); continue; }
    const dataUrl = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(f); });
    const r = await fetch('/api/attach', { method: 'POST', headers: { 'Content-Type': 'application/json', ...ACT_HEADERS }, body: JSON.stringify({ dataUrl }) })
      .then((x) => (staleToken(x) ? { ok: false, out: 'Reloading the page; paste the image again.' } : x.json()))
      .catch(() => ({ ok: false, out: 'Upload failed: the console did not answer.' }));
    if (!r.ok) { toast(r.out); continue; }
    attPaths = { ...attPaths, [r.name]: r.path }; store.set('attPaths', attPaths);
    if (ta.hidden) m.querySelector('[data-tab="write"]').click();
    const a = ta.selectionStart;
    ta.setRangeText(`${a && ta.value[a - 1] !== '\n' ? '\n' : ''}![image](${r.url})\n`, a, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.focus();
}
document.addEventListener('paste', (e) => {
  if (!e.target.matches?.('.mde-in')) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  attachFiles(e.target.closest('.mde'), files);
});
document.addEventListener('dragover', (e) => { const m = e.target.closest?.('.mde'); if (m && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); m.classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { const m = e.target.closest?.('.mde'); if (m && !m.contains(e.relatedTarget)) m.classList.remove('drag'); });
// A file dropped outside an editor must not make the browser open it and leave the console.
addEventListener('dragover', (e) => { if (!e.target.closest?.('.mde') && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
addEventListener('drop', (e) => { if (!e.target.closest?.('.mde')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const m = e.target.closest?.('.mde'); if (!m) return;
  e.preventDefault(); m.classList.remove('drag');
  attachFiles(m, [...(e.dataTransfer?.files || [])]);
});

function applyMd(ta, kind) {
  if (kind === 'attach') {
    const pick = document.createElement('input');
    pick.type = 'file'; pick.accept = 'image/png,image/jpeg,image/gif,image/webp'; pick.multiple = true;
    pick.onchange = () => attachFiles(ta.closest('.mde'), [...pick.files]);
    pick.click();
    return;
  }
  const { selectionStart: a, selectionEnd: b, value: v } = ta;
  const sel = v.slice(a, b);
  const wrap = (l, r = l, ph = 'text') => {
    const t = sel || ph;
    ta.setRangeText(l + t + r, a, b, 'end');
    if (!sel) { ta.selectionStart = a + l.length; ta.selectionEnd = a + l.length + t.length; }
  };
  const lines = (fn) => {
    const s0 = v.lastIndexOf('\n', a - 1) + 1; let e0 = v.indexOf('\n', b); if (e0 < 0) e0 = v.length;
    ta.setRangeText(v.slice(s0, e0).split('\n').map(fn).join('\n'), s0, e0, 'select');
  };
  ({
    bold: () => wrap('**'), italic: () => wrap('_'), code: () => wrap('`'), link: () => wrap('[', '](https://)', 'link text'),
    ul: () => lines((l) => `- ${l}`), ol: () => lines((l, i) => `${i + 1}. ${l}`), quote: () => lines((l) => `> ${l}`),
    block: () => wrap('```\n', '\n```', 'code'),
  })[kind]?.();
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export const editorSend = {}; // editor key prefix -> async (id, text) => sent?
document.addEventListener('click', (e) => {
  const m = e.target.closest('.mde'); if (!m) return;
  const ta = m.querySelector('.mde-in');
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const preview = tab.dataset.tab === 'preview';
    m.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === tab));
    const p = m.querySelector('.mde-prev');
    ta.hidden = preview; p.hidden = !preview;
    if (preview) p.innerHTML = ta.value.trim() ? md(ta.value) : '<p class="note">Nothing to preview yet.</p>'; else ta.focus();
    return;
  }
  const tool = e.target.closest('[data-md]');
  if (tool) { if (ta.hidden) m.querySelector('[data-tab="write"]').click(); applyMd(ta, tool.dataset.md); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    ta.value = ta.value.replace(new RegExp(`\\n?!\\[[^\\]\\n]*\\]\\(\\/api\\/attachments\\/${rm.dataset.rm.replace(/\./g, '\\.')}\\)\\n?`), '\n').replace(/^\n/, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (e.target.closest('.mde-send')) sendEditor(m);
  else if (e.target.closest('.mde-cancel')) closeQuickReply();
});
// Flipping the switch in any editor turns Send to agent on or off everywhere (turning on checks the permission first).
document.addEventListener('change', async (e) => {
  if (!e.target.matches?.('[data-agent-switch]')) return;
  const want = e.target.checked;
  if (want && !(await showAutoStatus())) { e.target.checked = false; $('autoDlg').showModal(); return; }
  ui.autoSend = want; store.set('autoSend', want);
  renderSendBtn();
  if (qrSid) { const s = ui.sessions.find((x) => x.sessionId === qrSid); const d = delivery(s); const m = $('qr'); m.querySelector('.mde-send').textContent = d.label; m.querySelector('.mde-hint').textContent = d.how; }
});
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('.mde-in')) return;
  const m = e.target.closest('.mde');
  drafts.set(m.dataset.mde, e.target.value);
  const strip = attStrip(e.target.value);
  if (m.querySelector('.mde-att').innerHTML !== strip) m.querySelector('.mde-att').innerHTML = strip;
});
document.addEventListener('keydown', (e) => {
  if (!e.target.matches?.('.mde-in')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); sendEditor(e.target.closest('.mde')); }
  else if (mod && ['b', 'i', 'k'].includes(e.key)) { e.preventDefault(); applyMd(e.target, { b: 'bold', i: 'italic', k: 'link' }[e.key]); }
}, true);

async function sendEditor(m) {
  const key = m.dataset.mde;
  const ta = m.querySelector('.mde-in');
  const text = ta.value.trim();
  if (!text) { if (ta.hidden) m.querySelector('[data-tab="write"]').click(); ta.focus(); return; }
  const btn = m.querySelector('.mde-send'); btn.disabled = true;
  const i = key.indexOf(':');
  const { text: out, files } = expandAttachments(text);
  const ok = await editorSend[key.slice(0, i)]?.(key.slice(i + 1), out, files);
  btn.disabled = false;
  if (ok) { ta.value = ''; drafts.set(key, ''); }
}

// How a reply reaches a session: sent for real where Claude Code allows it, otherwise copied with a jump to the right place.

export function delivery(s) {
  if (s.appId && ui.autoSend) return { label: 'Send to agent', how: 'Opens the session in the Claude app, pastes your reply and presses Enter (with checks).' };
  if (s.appId) return { label: 'Copy & open in app', how: 'Copies it and opens this session in the Claude app: paste, then Enter.' };
  if (!s.running) return { label: 'Send', how: 'Sends it: the session continues in the background.' };
  if (s.kind === 'background') return { label: 'Copy & attach', how: 'Copies it and attaches the agent in Terminal: paste it there.' };
  return { label: 'Copy', how: 'Copies it: paste it in the session’s terminal.' };
}
export async function deliver(s, text) {
  if (s.appId && ui.autoSend) {
    toast('Sending to the agent… hands off the keyboard and mouse until it says Sent. The first send looks for the app’s message box, which takes about 20 seconds.', 25000);
    const r = await action('send-app', { sessionId: s.sessionId, text });
    if (!r.ok && (r.why === 'accessibility' || r.why === 'automation')) { ui.autoSend = false; store.set('autoSend', false); renderSendBtn(); }
    return r.ok;
  }
  if (s.appId || s.running) {
    try { await navigator.clipboard.writeText(text); } catch {}
    if (s.appId) { const r = await action('open-app', { sessionId: s.sessionId }); if (r.ok) toast('Copied. The session is open in the Claude app: paste and press Enter.', 6000); return r.ok; }
    if (s.kind === 'background') { const r = await action('terminal', { sessionId: s.sessionId }); if (r.ok) toast('Copied. Paste it in the Terminal window that just opened.', 6000); return r.ok; }
    toast('Copied: paste it in the session’s terminal.', 5000);
    return true;
  }
  const r = await action('continue', { sessionId: s.sessionId, text });
  return r.ok;
}
editorSend.reply = async (sid, text) => {
  const s = ui.sessions.find((x) => x.sessionId === sid); if (!s) return false;
  const ok = await deliver(s, text);
  if (ok && qrSid === sid) closeQuickReply();
  return ok;
};

// Quick reply: a small floating editor attached to a card (cards re-render live, so it can't live inside one).
let qrSid = null;
export function openQuickReply(sid, anchor) {
  const s = ui.sessions.find((x) => x.sessionId === sid); if (!s) return;
  const d = delivery(s);
  qrSid = sid;
  $('qr-dot').className = `dot ${s.phase}`;
  $('qr-title').textContent = s.title;
  $('qr-body').innerHTML = editorHtml(`reply:${sid}`, { placeholder: `Reply to “${s.title}” in Markdown…`, send: d.label, cancel: 'Cancel', hint: d.how, agentSwitch: !!s.appId });
  const qr = $('qr'); qr.hidden = false;
  const r = (anchor || document.querySelector(`.card[data-sid="${esc(sid)}"]`))?.getBoundingClientRect() || { left: innerWidth / 2 - 240, bottom: 120, top: 120 };
  const h = qr.offsetHeight, w = qr.offsetWidth;
  const top = r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6);
  qr.style.top = `${top}px`;
  qr.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  const ta = qr.querySelector('.mde-in'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
export function closeQuickReply() { $('qr').hidden = true; qrSid = null; }
$('qr-close').onclick = closeQuickReply;
document.addEventListener('mousedown', (e) => { if (!$('qr').hidden && !e.target.closest('#qr') && !e.target.closest('[data-quick]')) closeQuickReply(); });
