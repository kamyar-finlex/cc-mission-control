import { $, action, setHtml, ui } from './core.js';
import { ago, esc } from './util.js';

// The usage toolbar: plan limits and when they reset.

const until = (sec) => { const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000)); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
// Like the app's usage card: "Current session" plus each weekly limit, with reset times.
const windowLabel = (l) => (/5-hour|five/i.test(l) ? 'Current session' : l.replace(/^Weekly · /, 'Weekly · '));
function resetText(ms) {
  if (!ms) return '';
  if (ms <= Date.now()) return 'reset';
  if (ms - Date.now() < 24 * 3600e3) return `resets in ${until(ms / 1000)}`;
  return `resets ${new Date(Math.round(ms / 60000) * 60000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function renderUsage() {
  const plan = ui.usage.plan;
  let html;
  if (plan?.windows?.length) {
    html = (plan.plan ? `<span class="lbl">${esc(plan.plan)}</span>` : '') + plan.windows.map((w) => {
      // Once a window has reset, its usage starts again from zero.
      const didReset = w.resetsAt && w.resetsAt <= Date.now();
      const used = didReset ? 0 : Math.round(w.used);
      const label = windowLabel(w.label);
      const reset = resetText(w.resetsAt);
      return `<span class="meter" title="${esc(label)}: ${used}% used, ${100 - used}% left${reset ? ` · ${reset}` : ''}${didReset ? ' (new window, no fresh reading yet)' : ''}">
        <span>${esc(label)}</span>
        <span class="bar"><i class="${used >= 80 ? 'high' : used >= 50 ? 'mid' : ''}" style="width:${Math.min(100, used)}%"></i></span>
        <b>${used}% used</b><span>${reset}</span></span>`;
    }).join('');
    const age = Date.now() - (plan.updatedAt || 0);
    html += `<span class="${age > 45 * 60e3 ? 'stale' : ''}" title="Source: ${esc(plan.source || '')}">updated ${ago(plan.updatedAt)} ago</span>`;
  } else {
    html = `<span title="Comes from the usage task in the Claude app (see setup) or from a terminal claude session">No usage reading yet: it appears after the usage task’s first run or a terminal <code>claude</code> session.</span>`;
  }
  const waiting = refreshingSince && (plan?.updatedAt || 0) <= refreshingSince.baseline && Date.now() - refreshingSince.at < 5 * 60e3;
  if (!waiting) refreshingSince = null;
  html += `<button class="iconbtn urefresh" id="usageRefresh" ${waiting ? 'disabled' : ''} title="Refresh usage now">${waiting ? '↻ refreshing…' : '↻ Refresh'}</button>`;
  setHtml($('usage'), `<div class="grp">${html}</div>`);
}
setInterval(renderUsage, 30000);
let refreshingSince = null;
$('usage').addEventListener('click', async (e) => {
  if (!e.target.closest('#usageRefresh')) return;
  const baseline = ui.usage.plan?.updatedAt || 0;
  const r = await action('refresh-usage');
  if (r.opened) { refreshingSince = { baseline, at: Date.now() }; renderUsage(); }
});
