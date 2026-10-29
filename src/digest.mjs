import { linearScans } from './linear.mjs';
import { state } from './state.mjs';

// The daily digest the project-updates skill reads.
// Everything the project-updates skill needs for one day, grouped by Linear project.
// Sessions with no Linear project are listed apart and left out of the updates.

function dayRange(range) {
  const d = new Date();
  const day = (back) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  if (range === 'yesterday') return { from: day(1), to: day(0), label: 'yesterday' };
  if (range === 'week') return { from: day((d.getDay() + 6) % 7), to: Infinity, label: 'this week' };
  return { from: day(0), to: Infinity, label: 'today' };
}

export function digest(range) {
  const { from, to, label } = dayRange(range);
  const inDay = (ts) => ts >= from && ts < to;
  const projects = new Map();
  const unassigned = [];
  for (const s of state.sessions) {
    if (!inDay(s.lastTs || 0)) continue;
    const st = linearScans.get(s.sessionId);
    const recaps = (st?.story.recaps || []).filter((r) => inDay(r.ts)).map((r) => r.text);
    const asks = (st?.story.asks || []).filter((a) => inDay(a.ts)).map((a) => a.text);
    if (!recaps.length && !asks.length) continue; // nothing a person did that day
    const entry = {
      title: s.title, phase: s.phase,
      story: s.story?.written?.text || s.story?.stitched || '',
      recapsThatDay: recaps.slice(-12), asksThatDay: asks.slice(-8),
      stillOpen: (s.openItems || []).map((i) => i.text).slice(0, 6),
      tickets: (s.linear?.tickets || []).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      pullRequests: (s.prs || []).filter((p) => p.state).map((p) => ({ repo: p.repo, number: p.number, title: p.title, state: p.state, mergedAt: p.mergedAt })),
      deployments: (s.deploys || []).map((x) => ({ repo: x.repo, version: x.version, stage: x.label })),
    };
    const project = s.linear?.projects?.[0];
    if (!project) { unassigned.push(s.title); continue; }
    if (!projects.has(project.name)) projects.set(project.name, { name: project.name, url: project.url, sessions: [] });
    projects.get(project.name).sessions.push(entry);
  }
  return { range: label, from: new Date(from).toISOString(), generatedAt: new Date().toISOString(), projects: [...projects.values()], unassigned };
}
