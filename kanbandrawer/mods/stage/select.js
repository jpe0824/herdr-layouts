// Pure selection helpers for the stage mod: which card the active space shows, which sub-tab
// it opens on, and which PRs belong to the card's family. No imports: tested under plain node.

export const inside = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir + "/"));

const REVIEW_NAME = /^Review (\S+) #(\d+)$/;

// What the active space is about: a board card (its root card, when the space sits in a child
// card's worktree), a herdr-review space, or nothing (a seat, a plain folder).
//   space:      the active SpaceInfo
//   spacePanes: panes() in that space's tabs
//   cards:      board.json's cards
//   seatSpaces: names of seat spaces (seats.json `space`)
//   reviews:    reviews.json's prs, to give a review space its full repo name
export function activeTarget({ space, spacePanes = [], cards = {}, seatSpaces = [], reviews = [], org = "" }) {
  if (!space) return null;
  if (seatSpaces.includes(space.name)) return null;
  const m = REVIEW_NAME.exec(space.name ?? "");
  const folderPr = /\/([^/]+)\/pr-(\d+)$/.exec(space.folder ?? "");
  if (m || folderPr) {
    const short = m ? m[1] : folderPr[1];
    const number = Number(m ? m[2] : folderPr[2]);
    const known = reviews.find((p) => p.repo?.split("/").pop() === short && p.number === number);
    return { kind: "review", repo: known?.repo ?? (org ? `${org}/${short}` : short), number, title: known?.title ?? null };
  }
  const where = [space.folder, ...spacePanes.map((p) => p.cwd)].filter(Boolean);
  let best = null;
  for (const c of Object.values(cards)) {
    if (!c.path || !where.some((w) => inside(w, c.path))) continue;
    if (!best || c.path.length > best.path.length) best = c;
  }
  if (!best) return null;
  const root = best.parent && cards[best.parent] ? cards[best.parent] : best;
  return { kind: "card", card: root };
}

// The sub-tab to show: a manual pick sticks while the card's stage is unchanged; otherwise the
// stage's default. Pending opens on the tab of the stage it paused from.
export function chooseTab({ stage, from, avail, saved, defaultTab }) {
  if (!avail.length) return null;
  if (saved && saved.stage === stage && avail.includes(saved.tab)) return saved.tab;
  const s = stage === "pending" && from ? from : stage;
  return defaultTab(s, avail) ?? avail[0];
}

const prsOf = (c) => (c?.prs?.length ? c.prs : c?.pr?.number ? [c.pr] : []);

// Every PR in a card's family: the card's own, then each child's, each tagged with its repo.
export function familyPrs(card, cards = {}) {
  if (!card) return [];
  const out = prsOf(card).map((p) => ({ ...p, repo: p.repo ?? card.repo, path: card.path, own: true }));
  for (const k of Object.values(cards)) {
    if (k.parent !== card.path) continue;
    for (const p of prsOf(k)) out.push({ ...p, repo: p.repo ?? k.repo, path: k.path, own: false });
  }
  return out;
}

// The PR the PR tab opens on: the card's `pr` (herdr-board's pick), else the newest open, else
// the newest.
export function defaultPr(card, family) {
  if (!family.length) return null;
  const pick = card?.pr?.number ? family.find((p) => p.number === card.pr.number && p.repo === (card.pr.repo ?? card.repo)) : null;
  return pick ?? [...family].reverse().find((p) => p.state === "OPEN") ?? family[family.length - 1];
}

// Merged PRs, newest merge first.
export function mergedNewestFirst(family) {
  return family.filter((p) => p.state === "MERGED")
    .sort((a, b) => (Date.parse(b.merged_at ?? "") || 0) - (Date.parse(a.merged_at ?? "") || 0));
}

export const runIdOf = (url) => /\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1] ?? null;

export const docKind = (path) => (/\/docs\/superpowers\/specs\//.test(path) ? "Spec" : /\/docs\/superpowers\/plans\//.test(path) ? "Plan" : null);

// Docs that turned unseen since the last look (`before`: the previous unseen set, or null on the
// first look at this card, which sets the baseline and switches nothing). The newest one wins.
export function newlyUnseen(before, now, docs) {
  if (!before) return null;
  const fresh = [...now].filter((p) => !before.has(p));
  if (!fresh.length) return null;
  const all = [...(docs?.specs ?? []), ...(docs?.plans ?? [])].filter((d) => fresh.includes(d.path));
  all.sort((a, b) => b.mtime - a.mtime);
  return all[0]?.path ?? fresh[0];
}

// Deploy gates (shared "ci.gates".gates) held for one repo, `owner/name`, compared
// case-insensitively. The run link falls back to the run's page when a gate has no url.
export function gatesForRepo(gates, repo) {
  const want = String(repo ?? "").toLowerCase();
  if (!want) return [];
  return (Array.isArray(gates) ? gates : []).filter((g) => String(g?.repo ?? "").toLowerCase() === want)
    .map((g) => ({ ...g, link: g.url ?? (g.runId ? `https://github.com/${g.repo}/actions/runs/${g.runId}` : null) }));
}

// "Deployment waiting for approval: <title or workflow> · <env> · by <actor>", parts left out when empty.
export const gateLine = (g) => ["Deployment waiting for approval: " + (g.title || g.workflow || "deployment"), g.env, g.actor ? `by ${g.actor}` : ""].filter(Boolean).join(" · ");

// A gate is the card's own when its commit is a family PR's merge commit (the card's or a child's)
// or its branch is the card's branch. Only those may be approved from the stage column.
export function isOwnGate(gate, card, kids = []) {
  if (!gate || !card) return false;
  const shas = new Set([card, ...(Array.isArray(kids) ? kids : [])].flatMap((c) => prsOf(c)).map((p) => p?.merge_sha).filter(Boolean));
  if (gate.headSha && shas.has(gate.headSha)) return true;
  return Boolean(gate.branch && card.branch && gate.branch === card.branch);
}
