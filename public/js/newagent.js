import { $, action, toast, ui } from './core.js';
import { drafts, editorHtml, editorSend, expandAttachments } from './editor.js';

// The New agent dialog: a prompt and a folder, opened in the Claude app or run in the background.

$('newBtn').onclick = () => {
  const s = ui.sessions.find((x) => x.sessionId === ui.selected) || ui.sessions[0];
  if (s && !$('nf-cwd').value) $('nf-cwd').value = s.cwd;
  $('nf-editor').innerHTML = editorHtml('new:', { placeholder: 'What should Claude do? Markdown welcome.', send: 'Open in Claude app', hint: 'Opens a new Claude app session with this prompt typed in: press Enter there.  ⌘↩' });
  $('newDlg').showModal(); $('nf-editor').querySelector('.mde-in').focus();
};
// Enter in the folder field must not submit (and close) the dialog.
$('newForm').addEventListener('submit', (e) => { if (e.submitter?.value !== 'cancel') e.preventDefault(); });
editorSend.new = async (_, text, files) => {
  const cwd = $('nf-cwd').value.trim();
  if (!cwd) { toast('Pick a folder first'); $('nf-cwd').focus(); return false; }
  const r = await action('new-in-app', { cwd, prompt: text, files });
  if (r.ok) $('newDlg').close();
  return r.ok;
};
$('nf-bg').onclick = async () => {
  const ta = $('nf-editor').querySelector('.mde-in');
  const prompt = expandAttachments(ta.value.trim()).text; const cwd = $('nf-cwd').value.trim();
  if (!prompt || !cwd) { toast('Folder and prompt are required'); return; }
  $('nf-bg').disabled = true;
  const r = await action('dispatch', { cwd, prompt, model: $('nf-model').value, permissionMode: $('nf-perm').value });
  $('nf-bg').disabled = false;
  if (r.ok) { ta.value = ''; drafts.set('new:', ''); $('newDlg').close(); }
};
