// Runs of one schedule, grouped. A scheduled task can start dozens of sessions a day (and numbered
// copies of a task, like autopilot-agent-2 and -3, are slots of one schedule); one card per run
// would bury everything else. No DOM: the tests import this.

// A column's sessions, in order, as cards and groups. A group takes the place of its newest run (the
// first one in the column) and holds the rest. Working runs, and runs that need the user (`standsOut`:
// one that asks something or is blocked), are never grouped: they stay in view on their own card.
// A schedule with a single run here is just a card.
export function groupRuns(list, { isUnread = () => false, standsOut = () => false } = {}) {
  const family = (s) => s.phase !== 'working' && !standsOut(s) && s.schedule?.family;
  const byFamily = new Map();
  for (const s of list) {
    const f = family(s);
    if (f) (byFamily.get(f) || byFamily.set(f, []).get(f)).push(s);
  }
  const out = [];
  const placed = new Set();
  for (const s of list) {
    const f = family(s);
    const runs = f && byFamily.get(f);
    if (!runs || runs.length < 2) { out.push({ type: 'card', s }); continue; }
    if (placed.has(f)) continue;
    placed.add(f);
    out.push({
      type: 'group', family: f, lead: runs[0], rest: runs.slice(1),
      name: f.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), // autopilot-agent -> "Autopilot agent"
      slots: new Set(runs.map((r) => r.schedule.id)).size,
      unread: runs.filter(isUnread).length,
    });
  }
  return out;
}
