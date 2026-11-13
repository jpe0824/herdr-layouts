// Verbatim copy of mods/stage/logic.js: a mod cannot import from another mod's folder
// ("resolves outside the application directory"). Keep in step with that file.
// Pure logic for the stage mod. No imports: tested under plain node.

export const CI_RUNNING_TEXT = "CI still running — advised to wait until it finishes.";

export function parsePlanTasks(md) {
  const out = [];
  for (const line of String(md ?? "").split("\n")) {
    const m = /^###\s+Task\s+(\d+):\s*(.*?)\s*$/.exec(line);
    if (m) out.push({ n: Number(m[1]), title: m[2] });
  }
  return out;
}

export function parseLedger(md) {
  const done = new Set();
  const firstLine = new Map();
  let rulings = 0;
  let last = null;
  for (const line of String(md ?? "").split("\n")) {
    if (line.trim()) last = line;
    const d = /^Task (\d+): complete\b/.exec(line);
    if (d) {
      const n = Number(d[1]);
      done.add(n);
      if (!firstLine.has(n)) firstLine.set(n, line);
    }
    if (/^Task \d+: Ruling:/.test(line) || /^Final: .*Ruling/.test(line)) rulings++;
  }
  return { done, firstLine, rulings, last };
}

export function progressOf(tasks, ledger) {
  const done = ledger?.done ?? new Set();
  const doneCount = tasks.filter((t) => done.has(t.n)).length;
  const cur = tasks.find((t) => !done.has(t.n));
  return {
    done: doneCount,
    total: tasks.length,
    current: cur ? cur.n : null,
    lastLine: ledger?.last ?? null,
    rulings: ledger?.rulings ?? 0,
  };
}

function normPath(p) {
  const abs = p.startsWith("/");
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}

export function resolveLedger(worktree, planAbs, markers) {
  const target = normPath(planAbs);
  for (const m of markers ?? []) {
    const p = m.planPath.startsWith("/") ? m.planPath : `${worktree}/${m.planPath}`;
    if (normPath(p) === target) return `${m.dir}/progress.md`;
  }
  return null;
}

export function discoverDocs(entries) {
  const specs = [];
  const plans = [];
  for (const e of entries ?? []) {
    if (/(^|\/)docs\/superpowers\/specs\/[^/]+\.md$/.test(e.path)) specs.push(e);
    else if (/(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/.test(e.path) && !e.path.endsWith(".progress.md")) plans.push(e);
  }
  const byNew = (a, b) => b.mtime - a.mtime;
  return { specs: specs.sort(byNew), plans: plans.sort(byNew) };
}

export function availableTabs(card, docs, prs) {
  const tabs = [];
  const hasPlan = !!docs?.plans?.length;
  if (card?.issue) tabs.push("Issue");
  if (docs?.specs?.length) tabs.push("Spec");
  if (hasPlan) tabs.push("Plan");
  if (hasPlan) tabs.push("Progress");
  if (prs?.length) tabs.push("PR");
  if ((prs ?? []).some((p) => p.state === "MERGED")) tabs.push("CI");
  return tabs;
}

const DEFAULTS = {
  claimed: ["Issue"],
  planning: ["Plan", "Spec", "Issue"],
  in_progress: ["Progress"],
  in_review: ["PR"],
  done: ["CI"],
  pending: ["Progress", "Plan", "Issue"],
};

export function defaultTab(stage, avail) {
  for (const t of DEFAULTS[stage] ?? []) if (avail.includes(t)) return t;
  return avail[0];
}

export function unseenDocs(docs, seen) {
  const list = Array.isArray(docs) ? docs : [...(docs?.specs ?? []), ...(docs?.plans ?? [])];
  const out = new Set();
  for (const d of list) {
    const prev = seen?.[d.path];
    if (prev === undefined || d.mtime > prev) out.add(d.path);
  }
  return out;
}

export function ciAdvisory(prs) {
  const states = (prs ?? []).map((p) => p.merge_ci?.state);
  if (states.includes("running")) return { state: "running", text: CI_RUNNING_TEXT };
  if (states.includes("failure")) return { state: "failed", text: "CI failed" };
  return { state: null, text: null };
}

export function stageVisible({ card, isTeamReview, manualHidden }) {
  return !!((card || isTeamReview) && !manualHidden);
}

// The orient-and-plan prompt, word for word as herdr-q writes it.
export function planPrompt(c, defaultOrg = "") {
  const [org, repo] = c.repo.includes("/") ? c.repo.split("/") : [defaultOrg, c.repo];
  const full = org ? `${org}/${repo}` : repo;
  return `You are picking up ${repo} issue #${c.issue} in this worktree (branch ${c.branch}). Read the issue with \`gh issue view ${c.issue} --repo ${full} --comments\`; decisions may be in the comments. Verify its claims against the code before you plan around them, and check the work is not already done (look for merged PRs). Read CLAUDE.md if present. Then write a plan. Do not edit code, commit, or open a PR until the plan is approved.`;
}
