// Runs of one schedule, grouped. A scheduled task can start dozens of sessions a day (and numbered
// copies of a task, like nightly-report-2 and -3, are slots of one schedule); one card per run
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
      name: f.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), // nightly-report -> "Nightly report"
      slots: new Set(runs.map((r) => r.schedule.id)).size,
      unread: runs.filter(isUnread).length,
    });
  }
  return out;
}

// "Quiet" runs: a run of any scheduled task that says it had nothing to do. Such runs are routine for
// schedules that poll (a nightly report with no changes, an inbox check with nothing new), and the
// board can keep them from counting as new. Spotted from English wording, in what the run last said;
// anything that mentions a failure stays loud, and so does a run with a PR, a ticket, a deploy, an
// open question or anything else still open.
export const NOTHING_TO_DO = /\b(skipp(ed|ing)|nothing (new|to (do|process|report|review|send|act on))|no (changes|work|new \w+|pending \w+|queued \w+|open \w+|issues)\b|all clear|up to date|(queue|inbox) (is )?empty)|SKIP[-_]EMPTY/i;
export const SOMETHING_WRONG = /\b(fail(ed|s|ure)?|error|exception|limit|can't|cannot|couldn't|unable|blocked|denied|timed? ?out|not (connected|allowed|found|configured))\b/i;

export function isQuietRun(s) {
  if (!s.schedule || s.phase === 'working') return false;
  if (s.prs?.length || s.linear?.tickets?.length || s.deploys?.length || s.story?.waitingOn?.ask) return false;
  if (s.alive && s.alive.tone !== 'done') return false;
  const said = `${s.summary || ''}\n${s.lastAssistant || ''}`;
  return NOTHING_TO_DO.test(said) && !SOMETHING_WRONG.test(said);
}
