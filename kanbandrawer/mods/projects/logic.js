// Pure logic for the projects panel. Reads the shape `herdr-board projects` writes.
const ORDER = ["Done", "In Review", "In Progress", "Todo"];

const listed = (p) => [...(p.items ?? []), ...(p.later_blocked ?? []), ...(p.unphased ?? [])];

function tally(p) {
  const counts = {};
  const add = (status, n) => { if (n > 0) counts[status] = (counts[status] ?? 0) + n; };
  const phases = p.phases ?? [];
  if (phases.length) {
    for (const ph of phases) for (const [s, n] of Object.entries(ph.counts ?? {})) add(s, n);
    // Items with no phase are not counted in any phase.
    for (const i of p.unphased ?? []) add(i.status, 1);
  } else {
    for (const i of listed(p)) add(i.status, 1);
  }
  return counts;
}

// Current phase = the one marked state "current"; else the first with an item not Done;
// null when every phase is done.
function currentPhase(phases) {
  return phases.find((ph) => ph.state === "current")
    ?? phases.find((ph) => (ph.total ?? 0) - (ph.counts?.Done ?? 0) > 0)
    ?? null;
}

// Only blockers still open are listed in `blocked_by`; an item counts once even if
// it appears in more than one list.
function blockedCount(p) {
  const seen = new Set();
  for (const i of listed(p)) if (i.blocked_by?.length > 0) seen.add(`${i.repo}#${i.number}`);
  return seen.size;
}

export function summary(project) {
  const counts = tally(project);
  const statuses = [...ORDER.filter((s) => counts[s]), ...Object.keys(counts).filter((s) => !ORDER.includes(s))];
  const segments = statuses.map((status) => ({ status, count: counts[status] }));
  const total = segments.reduce((n, s) => n + s.count, 0);
  const done = counts.Done ?? 0;
  const phases = project.phases ?? [];
  let label = `${done}/${total} done`;
  if (phases.length) {
    const cur = currentPhase(phases);
    label = `${cur ? cur.name : "All phases done"} · ${label}`;
  }
  return { segments, label, open: total - done, blocked: blockedCount(project), target: project.target ?? null };
}

export function orderProjects(projects) {
  const triage = (p) => (p.title === "Triage" ? 1 : 0);
  return projects.map((p, n) => [p, n]).sort((a, b) => triage(a[0]) - triage(b[0]) || a[1] - b[1]).map(([p]) => p);
}

export function isExpanded(state, id) {
  return state?.[id] === true;
}
