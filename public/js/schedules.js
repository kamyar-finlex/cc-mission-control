// Runs of one schedule, grouped. A scheduled task can start dozens of sessions a day (and numbered
// copies of a task, like autopilot-agent-2 and -3, are slots of one schedule); one card per run
// would bury everything else. No DOM: the tests import this.

// A column's sessions, in order, as cards and groups. A group takes the place of its newest run (the
// first one in the column) and holds the rest. Working runs are never grouped: active work stays in
// view on its own card. A schedule with a single run here is just a card.
export function groupRuns(list, { isUnread = () => false } = {}) {
  const byFamily = new Map();
  for (const s of list) {
    const f = s.phase !== 'working' && s.schedule?.family;
    if (f) (byFamily.get(f) || byFamily.set(f, []).get(f)).push(s);
  }
  const out = [];
  const placed = new Set();
  for (const s of list) {
    const f = s.phase !== 'working' && s.schedule?.family;
    const runs = f && byFamily.get(f);
    if (!runs || runs.length < 2) { out.push({ type: 'card', s }); continue; }
    if (placed.has(f)) continue;
    placed.add(f);
    out.push({
      type: 'group', family: f, lead: runs[0], rest: runs.slice(1),
      name: runs[0].title.replace(/\s+\d+$/, ''), // "Autopilot agent 2" -> "Autopilot agent"
      slots: new Set(runs.map((r) => r.schedule.id)).size,
      unread: runs.filter(isUnread).length,
    });
  }
  return out;
}
