import { section } from './board.js';
import { $ } from './core.js';
import { delivery } from './editor.js';
import { ago, cls, esc } from './util.js';

// Repositories this session is shipping: version and how far it got, the ones still short of production first.
export const DEPLOY_ICON = { gate: '⏸', beta: '🧪', tagged: '🏷', ready: '📦', prod: '✓' };
export function deploysPanel(s) {
  const d = s.deploys; if (!d?.length) return '';
  const pending = d.filter((x) => x.stage !== 'prod').length;
  const rows = d.map((x) => `<div class="drow2 st-${cls(x.stage)}" title="${esc(x.evidence)}">
      <span class="dic">${DEPLOY_ICON[x.stage] || '•'}</span><span class="drepo">${esc(x.repo)}</span><span class="dver">${esc(x.version)}</span>
      <span class="dstage">${esc(x.label)}</span><span class="dev">${esc(x.evidence)}</span><span class="ts">${x.ts ? `${ago(x.ts)} ago` : ''}</span>
      ${x.stage !== 'prod' ? `<button type="button" class="dbtn" data-deploy="${esc(x.repo)}" title="Ask this session's agent to deploy ${esc(x.repo)} ${esc(x.version)} to production (it reports the risks first and waits for your yes)">🚀 Deploy</button>` : ''}</div>`).join('');
  return section('deploys', `Deployments <span class="cnt">${pending ? `${pending} not in production yet` : 'all in production'}</span>`, `<div class="dlist">${rows}</div>`);
}

// The deploy itself is the session's agent's job (it knows the release); this only asks it, and the agent
// must report the risks and wait for an explicit yes before touching production.
export const deployPrompt = (x) => `Please deploy **${x.repo} ${x.version}** to production.

Before you change anything:
1. Check what ${x.version} contains and whether anything about it is risky: checks that failed or weren't run, unverified changes, open or unmerged pieces, migrations or config changes, other releases it depends on, and timing.
2. Tell me those risks plainly (or say you found none), and exactly what you will do to deploy it, for example which gate you will approve.
3. Then stop and wait for my explicit "yes, deploy". Don't deploy before that, even if you found no risk.`;

export let deployTarget = null;
export function openDeploy(s, repo) {
  const x = (s.deploys || []).find((d) => d.repo === repo); if (!x) return;
  deployTarget = { sid: s.sessionId, x };
  const d = delivery(s);
  $('dd-body').innerHTML = `
    <div class="dsum">🚀 <b>${esc(x.repo)}</b> <span class="dver" style="font-family:var(--mono)">${esc(x.version)}</span> → <b>production</b></div>
    <div class="dwarn"><b>Now:</b> ${esc(x.label)}.<br><span style="color:var(--muted)">From the session: “${esc(x.evidence)}”</span></div>
    <div style="font-size:13px">What happens if you confirm:</div>
    <ol class="dwhat">
      <li>“${esc(s.title)}” is asked to deploy it. <span style="color:var(--muted)">(${esc(d.how)})</span></li>
      <li>Its agent first checks the risks and tells you what it found and what it will do.</li>
      <li><b>Nothing is deployed until you answer “yes, deploy” in that session.</b></li>
    </ol>
    <details style="font-size:12px;color:var(--muted)"><summary>The message it will get</summary><pre style="white-space:pre-wrap">${esc(deployPrompt(x))}</pre></details>`;
  $('dd-go').textContent = d.label === 'Send to agent' ? 'Yes, ask Claude to deploy' : `Yes: ${d.label.toLowerCase()}`;
  $('deployDlg').showModal();
}
$('dd-cancel').onclick = () => $('deployDlg').close();
