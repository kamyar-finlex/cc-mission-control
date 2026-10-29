import { clip } from './transcript.mjs';

// Reading a session without a model: its story, what is still open, and what it is deploying.

const firstSentence = (t) => (t.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] || t).trim();

// A readable paragraph without a model: the opening request, the first
// sentence of a spread of turn recaps, and where it stands now.
export function stitch(story, s) {
  const first = story.asks[0]?.text;
  const recaps = story.recaps.map((r) => r.text);
  if (!first && !recaps.length) return s?.lastAssistant ? `Latest: ${s.lastAssistant}` : '';
  const parts = [];
  if (first) parts.push(`It started with: “${clip(first, 220)}”`);
  if (recaps.length > 1) {
    const middle = recaps.slice(0, -1);
    const pick = middle.length <= 6 ? middle : Array.from({ length: 6 }, (_, i) => middle[Math.round((i * (middle.length - 1)) / 5)]);
    const seen = new Set();
    const steps = pick.map(firstSentence).filter((x) => x && !seen.has(x) && seen.add(x));
    if (steps.length) parts.push(`Along the way: ${steps.join(' ')}`);
  }
  if (recaps.length) parts.push(`Now: ${recaps.at(-1)}`);
  else if (s?.lastAssistant) parts.push(`Latest: ${s.lastAssistant}`);
  return parts.join(' ');
}
export function sessionDigest(s, st) {
  const { asks, recaps, compacts } = st.story;
  return [
    `Session title: ${s.title}`,
    `Folder: ${s.cwd}${s.branch ? ` (branch ${s.branch})` : ''}`,
    s.linear?.tickets?.length ? `Linear tickets: ${s.linear.tickets.map((t) => `${t.id}${t.title ? ` "${t.title}"` : ''}${t.status ? ` [${t.status}]` : ''}`).join(', ')}` : '',
    s.prs?.length ? `Pull requests: ${s.prs.map((p) => `${p.repo}#${p.number}${p.state ? ` [${p.state}${p.review ? `, ${p.review}` : ''}]` : ''}`).join(', ')}` : '',
    compacts.length ? `Earlier context (compaction summary):\n${clip(compacts.at(-1).text, 3000)}` : '',
    `What the user asked, in order:\n${asks.slice(0, 40).map((a, i) => `${i + 1}. ${clip(a.text, 300)}`).join('\n')}`,
    recaps.length ? `End-of-turn recaps, in order:\n${recaps.slice(-60).map((r, i) => `${i + 1}. ${r.text}`).join('\n')}` : `Latest reply: ${s.lastAssistant || ''}`,
  ].filter(Boolean).join('\n\n');
}

// ---------- what is still open ----------

// Words that mark unfinished business in a recap sentence.
const OPEN_CUE = /\b(blocked|block(s|ing)|wait(s|ing)? (on|for)|awaiting|still (to|needs?|open|running|pending)|not (yet|verified|tested|checked|run|committed|pushed|merged|deployed|released|done)|isn't|aren't|hasn't|haven't|needs?\b|pending|remaining|left to|to do|todo|follow-?up|next step|open question|unverified|until|owed|depends on|requires?|must|has to|have to)\b/i;
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(#])/).map((x) => x.trim()).filter(Boolean);

// A first pass with no model: the open-sounding sentences of the last two
// recaps, unfinished Linear tickets and PRs that still need something.
export function openItemsFor(s, st) {
  const items = [];
  const seen = new Set();
  const add = (kind, text, extra = {}) => { const k = text.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push({ kind, text, ...extra }); } };
  for (const r of (st?.story.recaps || []).slice(-2).reverse())
    for (const x of sentencesOf(r.text)) if (OPEN_CUE.test(x) && !/^(nothing|no action|all done)\b/i.test(x)) add('note', x);
  for (const p of s.prs || []) if (p.state === 'OPEN')
    add('pr', `PR #${p.number} is open${p.isDraft ? ' as a draft' : ''}${p.review === 'REVIEW_REQUIRED' ? ' and needs a review' : p.review === 'CHANGES_REQUESTED' ? ' with changes requested' : p.review === 'APPROVED' ? ', approved and ready to merge' : ''}${p.checks === 'FAILURE' ? '; checks are failing' : ''}.`,
      { url: p.url, number: p.number, title: p.title, review: p.review, checks: p.checks, isDraft: p.isDraft, prState: p.state });
  for (const t of (s.linear?.tickets || []).slice(0, 4))
    if (t.status && !['completed', 'canceled'].includes(t.statusType) && !/^(done|duplicate|canceled|cancelled)$/i.test(t.status))
      add('ticket', `${t.id} is ${t.status}${t.title ? `: ${t.title}` : ''}.`, { url: t.url, id: t.id, title: t.title, status: t.status, statusType: t.statusType });
  return items.slice(0, 8);
}

// The one line a waiting card shows: the strongest reason this session is still
// alive, in its own voice. Strongest first: a question, a PR that needs someone, a
// blocker, unshipped or unverified work, a ticket still in progress.
export function aliveReason(s, items) {
  const ask = s.story?.waitingOn?.ask;
  if (ask) return { tone: 'ask', text: `Waiting for your answer: “${clip(ask, 110)}”` };
  for (const p of s.prs || []) if (p.state === 'OPEN') {
    if (p.review === 'CHANGES_REQUESTED') return { tone: 'block', text: `PR #${p.number} has changes requested. I need you.` };
    if (p.checks === 'FAILURE' || p.checks === 'ERROR') return { tone: 'block', text: `PR #${p.number} has failing checks. Don't forget me.` };
  }
  for (const p of s.prs || []) if (p.state === 'OPEN' && !p.isDraft)
    return p.review === 'APPROVED'
      ? { tone: 'ship', text: `PR #${p.number} is approved. Merge me.` }
      : { tone: 'wip', text: `PR #${p.number} is waiting for review. Don't archive me.` };
  const notes = items.filter((i) => i.kind === 'note').map((i) => i.text);
  const blocked = notes.find((n) => /\bblock(ed|s|ing)\b|\bwait(s|ing)? (on|for)|awaiting|depends on/i.test(n));
  if (blocked) return { tone: 'block', text: `Blocked: ${clip(blocked, 120)}` };
  const unshipped = notes.find((n) => /\b(deploy|release|beta|prod|live|publish|ship)/i.test(n));
  if (unshipped) return { tone: 'ship', text: `Not shipped yet: ${clip(unshipped, 120)}` };
  const unverified = notes.find((n) => /not (yet )?(verified|tested|checked|run|tried)|hasn't been (tried|tested|run)|unverified|still running/i.test(n));
  if (unverified) return { tone: 'wip', text: `Not verified yet: ${clip(unverified, 120)}` };
  const started = (s.linear?.tickets || []).find((t) => t.statusType === 'started' || /progress|review/i.test(t.status || ''));
  if (started) return { tone: 'wip', text: `${started.id} is still ${started.status}. Don't archive me.` };
  if (notes.length) return { tone: 'wip', text: clip(notes[0], 130) };
  const todo = (s.linear?.tickets || []).find((t) => t.status && !['completed', 'canceled'].includes(t.statusType) && !/^(done|duplicate|canceled|cancelled)$/i.test(t.status));
  if (todo) return { tone: 'wip', text: `${todo.id} is ${todo.status}. Someone has to pick it up.` };
  return { tone: 'done', text: 'Nothing open that I can see. Safe to archive.' };
}

// ---------- deployments ----------
// Which repositories a session is shipping, at which version, and how far they got,
// read from its turn recaps ("web-app 1.8.25 is on beta", "…still waits at the
// production gate"). A bare version joins the repository last named on its major.minor.

const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
// t is one sentence; versions like 6.28.25 contain dots, so patterns span the whole sentence (.*), not [^.]*.
export function deployStage(t) {
  if (/production gates?|prod(uction)? gates?|\bwait(s|ing)?\b.*\b(gates?|production|prod)\b|\bproduction\b.*\b(wait(s|ing)?|pending|unapproved|not approved)\b/i.test(t)) return 'gate';
  if (/\b(not|isn't|aren't|hasn't|never)\b.*\b(in|on|to) (production|prod)\b/i.test(t)) return undefined;
  if (/\b(live|deployed|released|running|shipped|rolled out)\b.*\b(in|on|to) (production|prod)\b|\b(in|on) production\b/i.test(t)) return 'prod';
  if (/\b(not|isn't|aren't)\b (yet )?on beta\b|beta still runs|\bnot (yet )?deployed\b/i.test(t)) return 'tagged';
  if (/\bon (beta|staging|preprod)\b|\b(beta|staging)\b.*\b(succeed|deployed|runs|live)\b|\bdeploy(ed)? .*\bto (beta|staging)\b/i.test(t)) return 'beta';
  if (/not cut|not tagged|\b(tag|release)\b.*\bready\b|\bready to (tag|release|ship|deploy)\b/i.test(t)) return 'ready';
  if (/live on github|\b(tag|release)\b.*\b(live|cut|published|pushed|created)\b|\btagged\b/i.test(t)) return 'tagged';
  return undefined;
}
const DEPLOY_LABEL = { prod: 'In production', gate: 'Waiting at the production gate', beta: 'On beta, not in production', tagged: 'Tagged, not on beta yet', ready: 'Ready, not tagged yet' };

export function deploysFor(st) {
  const repos = new Map();
  const family = new Map(); // "6.28" -> repository last named with that line
  for (const r of st?.story.recaps || []) for (const sent of sentencesOf(r.text)) {
    const found = [];
    for (const m of sent.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
      const fam = m[1].split('.').slice(0, 2).join('.');
      const named = sent.slice(Math.max(0, m.index - 40), m.index).match(/\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|shell)\s+(?:v)?$/i)?.[1]?.toLowerCase();
      const repo = named || family.get(fam);
      if (named) family.set(fam, named);
      if (repo) found.push([repo, m[1]]);
    }
    const stage = found.length ? deployStage(sent) : undefined;
    if (!stage) continue; // a version with no deploy wording (a benchmark, a mock) isn't a deployment
    for (const [repo, version] of found) {
      const cur = repos.get(repo);
      if (cur && cmpVer(version, cur.version) < 0) continue; // an older version mentioned later
      repos.set(repo, { repo, version, stage, label: DEPLOY_LABEL[stage], evidence: clip(sent, 220), ts: r.ts });
    }
  }
  const order = { gate: 0, beta: 1, tagged: 2, ready: 3, prod: 4 };
  return [...repos.values()].sort((a, b) => order[a.stage] - order[b.stage] || a.repo.localeCompare(b.repo));
}
