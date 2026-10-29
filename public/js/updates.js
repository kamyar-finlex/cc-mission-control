import { $, action, toast, ui } from './core.js';
import { deployPrompt, deployTarget, openDeploy } from './deploy.js';
import { current } from './drawer.js';
import { deliver } from './editor.js';
import { esc } from './util.js';

// Project updates: preview what the digest found, then hand over to the skill in a new Claude app session.
let puRange = 'today';
async function renderPu() {
  $('pu-range').querySelectorAll('[data-pu]').forEach((b) => b.classList.toggle('on', b.dataset.pu === puRange));
  $('pu-body').innerHTML = '<div class="note">Reading the sessions…</div>';
  const d = await fetch(`/api/digest?range=${puRange}`).then((r) => r.json()).catch(() => null);
  if (!d) { $('pu-body').innerHTML = '<div class="note">The console did not answer.</div>'; $('pu-go').disabled = true; return; }
  $('pu-go').disabled = !d.projects.length;
  const projects = d.projects.map((p) => `<div class="pproj"><b>${esc(p.name)}</b><span class="pmeta">${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'} · ${p.sessions.reduce((n, x) => n + x.recapsThatDay.length, 0)} updates from ${esc(d.range)}</span>
    <ul>${p.sessions.map((x) => `<li>${esc(x.title)}</li>`).join('')}</ul></div>`).join('');
  $('pu-body').innerHTML = (projects || `<div class="note">No session from ${esc(d.range)} belongs to a Linear project, so there is nothing to write.</div>`)
    + (d.unassigned.length ? `<div class="pleft">Left out (no Linear project): ${d.unassigned.map(esc).join(' · ')}</div>` : '');
}
$('puBtn').onclick = () => { $('puDlg').showModal(); renderPu(); };
$('pu-range').addEventListener('click', (e) => { const b = e.target.closest('[data-pu]'); if (b) { puRange = b.dataset.pu; renderPu(); } });
$('pu-cancel').onclick = () => $('puDlg').close();
$('pu-go').onclick = async () => {
  $('pu-go').disabled = true;
  const r = await action('project-updates', { range: puRange });
  $('pu-go').disabled = false;
  if (r.ok) $('puDlg').close();
};
$('dd-go').onclick = async () => {
  const t = deployTarget; if (!t) return;
  const s = ui.sessions.find((y) => y.sessionId === t.sid); if (!s) return;
  $('dd-go').disabled = true;
  const ok = await deliver(s, deployPrompt(t.x));
  $('dd-go').disabled = false;
  if (ok) { $('deployDlg').close(); toast(`Asked “${s.title}” to deploy ${t.x.repo} ${t.x.version}. It will report the risks and wait for your yes.`, 7000); }
};
$('d-linear').addEventListener('click', (e) => {
  const b = e.target.closest('[data-deploy]'); if (!b) return;
  e.preventDefault(); const s = current(); if (s) openDeploy(s, b.dataset.deploy);
});
