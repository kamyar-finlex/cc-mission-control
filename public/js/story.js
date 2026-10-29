import { storyPanel } from './board.js';
import { $, setHtml, toast, ui } from './core.js';
import { runAction } from './drawer.js';

// The session story dialog.

export let storySid = null;
export function renderStory() {
  const s = ui.sessions.find((x) => x.sessionId === storySid);
  if (!s) return;
  $('sd-dot').className = `dot ${s.phase}`;
  $('sd-title').textContent = s.title;
  setHtml($('sd-body'), storyPanel(s) || '<div class="story">Nothing to tell yet.</div>');
}
export function openStory(sid) { storySid = sid; renderStory(); if (!$('storyDlg').open) $('storyDlg').showModal(); }
$('sd-close').onclick = () => $('storyDlg').close();
$('storyDlg').addEventListener('click', (e) => {
  if (e.target === $('storyDlg')) { $('storyDlg').close(); return; } // backdrop
  if (e.target.closest('[data-act="copy-story"]')) {
    navigator.clipboard?.writeText($('sd-body').querySelector('.story')?.textContent || ''); toast('Story copied'); return;
  }
  const b = e.target.closest('[data-act="summarize"]'); if (b) runAction('summarize', storySid);
});
