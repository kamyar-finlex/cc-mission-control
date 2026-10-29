import { linearScans } from './linear.mjs';
import { run } from './proc.mjs';
import { state } from './state.mjs';

// Pull requests (read-only GitHub lookups via the gh CLI).

const prState = new Map(); // "owner/repo#n" -> { state, isDraft, review, checks, title, url, fetchedAt }
// Moves only when what a card shows about a PR changes (not on every refresh), so cached cards know when to rebuild.
export let prEpoch = 0;
const shown = (pr) => { if (!pr) return ''; const { fetchedAt, ...rest } = pr; return JSON.stringify(rest); };
const setPr = (key, pr) => { if (shown(pr) !== shown(prState.get(key))) prEpoch++; prState.set(key, pr); };

export function prsFor(sid) {
  const st = linearScans.get(sid);
  if (!st) return [];
  return [...st.prs].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => {
    const [repo, n] = key.split('#');
    // fetchedAt only schedules the next lookup; leaving it out keeps a refresh that changed nothing from changing the card.
    const { fetchedAt, ...pr } = prState.get(key) || {};
    return { key, repo, number: Number(n), url: `https://github.com/${repo}/pull/${n}`, ...pr };
  });
}

let prBusy = false;
export async function prTick() {
  if (prBusy) return;
  prBusy = true;
  try {
    const now = Date.now();
    const due = new Set();
    for (const s of state.sessions) for (const p of prsFor(s.sessionId)) {
      const known = prState.get(p.key);
      const maxAge = !known ? 0 : known.state === 'OPEN' ? 90e3 : 30 * 60e3; // merged/closed rarely change
      if (!known || now - known.fetchedAt > maxAge) due.add(p.key);
    }
    const keys = [...due];
    for (let i = 0; i < keys.length; i += 40) {
      const chunk = keys.slice(i, i + 40);
      const q = chunk.map((key, j) => {
        const [repo, n] = key.split('#');
        const [owner, name] = repo.split('/');
        return `p${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(n)}) {
          state isDraft reviewDecision title url mergedAt commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
      }).join('\n');
      const r = await run('gh', ['api', 'graphql', '-f', `query={ ${q} }`]);
      let data = {};
      // gh exits non-zero when any PR in the batch is missing, but stdout still has the rest.
      try { data = JSON.parse(r.stdout).data || {}; } catch { /* network or auth error, retry next tick */ }
      chunk.forEach((key, j) => {
        const pr = data[`p${j}`]?.pullRequest;
        if (pr) setPr(key, {
          state: pr.state, isDraft: pr.isDraft, review: pr.reviewDecision, title: pr.title, url: pr.url, mergedAt: pr.mergedAt,
          checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state, fetchedAt: now,
        });
        else if (data && Object.keys(data).length) setPr(key, { state: 'UNKNOWN', fetchedAt: now }); // no access or deleted
      });
    }
  } catch (e) { console.error('pr lookup failed', e); }
  finally { prBusy = false; }
}
