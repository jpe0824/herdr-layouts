// Pure logic for the board-strip mod. No imports: tested under plain node.

// A card is three lines: title, repo · chip, and its tab row.
export const CARD = 62;
export const GAP = 4;
export const HEAD = 24;
export const PAD = 14;
export const TALL_CARDS = 5;
export const MIN_COL = 96;
export const LEFT_COL = 210;
export const COUNT_W = 64;
// A card's tab row: chips are about TAB_CHIP_W wide (one icon), the "+k" tail MORE_W.
export const TAB_CHIP_W = 32;
export const TAB_GAP = 4;
export const MORE_W = 22;

export const ORDER = ["claimed", "planning", "in_progress", "in_review", "done", "pending"];
export const STAGE = { claimed: "TODO", planning: "Planning", in_progress: "In progress", pending: "Pending", in_review: "In review", done: "Done" };
export const DONE_KEEP_MS = 2 * 86400 * 1000;
export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isDue = (c, now = Date.now()) => c?.stage === "pending" && Boolean(c.pending?.until) && c.pending.until <= localDay(new Date(now));
const rank = (r) => RANK[r.agent?.status] ?? 0;

/** An agent needs you when it is blocked, or finished and unseen. A finished agent on a Done card is not news. */
export const agentNeedsYou = (a, card = null) =>
  a?.status === "blocked" || (a?.status === "done" && card?.stage !== "done");

export const heightFor = (n) => PAD + HEAD + n * CARD + (n - 1) * GAP;
export const snapCards = (px) => Math.max(1, Math.round((px - PAD - HEAD + GAP) / (CARD + GAP)));
export const isTall = (px) => snapCards(px) >= TALL_CARDS;
// The strip never snaps below its default height of two cards (layouts/kanbandrawer.json min matches).
export const MIN_CARDS = 2;
export const snapTarget = (px) => heightFor(Math.max(MIN_CARDS, snapCards(px)));

/**
 * cards: array or {path: card}. agentOf(card) -> agent ({status, ...}) | null; a Map or object keyed by path also works.
 * needs: agent rows ({need: agent, ...}) for the Needs you column. Cards never leave their stage column for it.
 * Returns columns [{id, label, rows}] where a card row is {c, agent}.
 */
export function columnsFor({ cards, agentOf, needs = [], teamReviews = [], others = [], now = Date.now() }) {
  const list = Array.isArray(cards) ? cards : Object.values(cards ?? {});
  const byPath = new Map(list.map((c) => [c.path, c]));
  const agent = typeof agentOf === "function" ? agentOf : (c) => (agentOf instanceof Map ? agentOf.get(c.path) : agentOf?.[c.path]) ?? null;
  const rows = list
    .filter((c) => !(c.parent && byPath.has(c.parent)))
    .filter((c) => !(c.stage === "done" && now - Date.parse(c.stage_changed ?? 0) > DONE_KEEP_MS))
    .map((c) => ({ c, agent: agent(c) ?? null }));
  // Every stage column shows, empty or not, so a column never jumps sideways; team and others only when present.
  const cols = [{ id: "needs", label: "Needs you", rows: needs }];
  for (const s of ORDER) cols.push({ id: s, label: STAGE[s], rows: rows.filter((r) => r.c.stage === s) });
  if (teamReviews.length) cols.push({ id: "team", label: "Team reviews", rows: teamReviews });
  if (others.length) cols.push({ id: "others", label: "Other agents", rows: others });
  return cols;
}

/** Due Pending cards first, then the selected card, then agent status by RANK. Stable. */
export function sortRows(rows, selectedPath, now = Date.now()) {
  const key = (r) => [isDue(r.c, now) ? 0 : 1, r.c?.path === selectedPath ? 0 : 1, -rank(r)];
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Width per column id, after LEFT_COL is taken off the top. A collapsed column is the string "count"
 * (drawn COUNT_W wide). Shares are never negative; a column only collapses when COUNT_W fits in what is left.
 */
export function columnWidths(total, ids) {
  const avail = Math.max(0, total - LEFT_COL);
  const live = [...ids];
  const collapsed = () => ids.length - live.length;
  const share = () => Math.floor((avail - COUNT_W * collapsed()) / Math.max(1, live.length));
  for (const id of ["others", "team"]) {
    if (share() >= MIN_COL) break;
    const i = live.indexOf(id);
    if (i < 0 || live.length < 2 || avail < COUNT_W * (collapsed() + 1)) continue;
    live.splice(i, 1);
  }
  const w = Math.max(0, share());
  const out = {};
  for (const id of ids) out[id] = live.includes(id) ? w : "count";
  return out;
}

/** Repo lanes: [{repo, cells: {colId: rows}}], repos alphabetical. Card columns only: Needs you is a side column. */
export function lanes(columns) {
  const byRepo = new Map();
  const cell = (repo, id) => {
    if (!byRepo.has(repo)) byRepo.set(repo, {});
    const cells = byRepo.get(repo);
    return (cells[id] ??= []);
  };
  for (const col of columns) {
    if (col.id === "needs" || col.id === "team" || col.id === "others") continue;
    for (const r of col.rows) cell((r.c.repo ?? "").split("/").pop() || "repo", col.id).push(r);
  }
  return [...byRepo.keys()].sort((a, b) => a.localeCompare(b)).map((repo) => ({ repo, cells: byRepo.get(repo) }));
}

/** How many of n tab chips fit in width px: {shown, more}; past the fit, the last slot becomes "+more". */
export function fitChips(n, width) {
  const fits = (k) => k * TAB_CHIP_W + Math.max(0, k - 1) * TAB_GAP;
  if (fits(n) <= width) return { shown: n, more: 0 };
  let shown = 0;
  while (shown + 1 < n && fits(shown + 1) + TAB_GAP + MORE_W <= width) shown++;
  shown = Math.max(1, shown);
  return { shown, more: n - shown };
}

export function cardDot(statuses) {
  for (const s of ["blocked", "done", "working", "idle"]) if (statuses.includes(s)) return s;
  return null;
}

/**
 * progress: {done, total} from progressOf, or null. unseen: {spec: bool, plan: bool}.
 * ci: "running" | "failed" | null. merged: true when any PR in the card's family is MERGED (defaults to the card's own PRs). tone: "info" | "warn" | "bad" | "ok". Returns null to fall back to board's detail().
 */
export function chip(card, { progress, unseen, ci, merged } = {}) {
  if (card.stage === "in_progress" && progress && progress.total > 0) return { text: `${progress.done}/${progress.total} tasks`, tone: "info" };
  if (card.stage === "planning" && unseen) {
    if (unseen.spec) return { text: "spec ●", tone: "warn" };
    if (unseen.plan) return { text: "plan ●", tone: "warn" };
  }
  if (card.stage === "done") {
    if (ci === "running") return { text: "CI running", tone: "info" };
    if (ci === "failed") return { text: "CI failed", tone: "bad" };
    const prs = card.prs?.length ? card.prs : card.pr ? [card.pr] : [];
    if (merged ?? prs.some((p) => p.state === "MERGED")) return { text: "merged", tone: "ok" };
  }
  return null;
}
