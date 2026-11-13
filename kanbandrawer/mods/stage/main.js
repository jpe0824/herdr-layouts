// The stage column (layout kanbandrawer): a fixed column right of the work side that follows the
// active space's board card and shows Issue · Spec · Plan · Progress · PR · CI. Cards come from
// ~/.claude/herdr/board.json (read only; herdr-board writes it). It draws its own 42px sub-tab
// header, level with the tab bar, and shows or hides its own `stage` block.
//
// Shared state it owns:
//   stage.manualHidden  true while hidden by hand (cmd-shift-\ or the header button)
//   stage.seen          { <absolute doc path>: <mtime ms> } for specs and plans viewed here
//   stage.tab           { <card path>: { tab, stage } }, a manual pick that holds until the stage changes

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { agents, panes, spaces, run, exec, home, readTextFile, watchFolder, notify, layout, nextCommand, shared, setShared, openOverlay, theme } from "herdr";
import { parsePlanTasks, parseLedger, progressOf, resolveLedger, discoverDocs, availableTabs, defaultTab, unseenDocs, ciAdvisory, stageVisible, planPrompt } from "./logic.js";
import { inside, activeTarget, chooseTab, familyPrs, defaultPr, gatesForRepo, gateLine, isOwnGate, mergedNewestFirst, runIdOf, docKind, newlyUnseen } from "./select.js";
import { pill, section, relTime, duration, stateOf, GLYPH, icon } from "./ci-ui.js";
import IssueView from "./issue-view.js";
import PrView from "./pr-view.js";

const TABS = ["Issue", "Spec", "Plan", "Progress", "PR", "CI"];
const HEAD = 42;
const SYNC_MS = 400;
const DOCS_MS = 15 * 1000;
const CI_MS = 20 * 1000;
const STAGE_NAME = { claimed: "TODO", planning: "Planning", in_progress: "In progress", pending: "Pending", in_review: "In review", done: "Done" };
const CI_COLOR = { success: "#3fb950", failure: "#f85149", warning: "#d29922", running: "#d29922", queued: "#8b949e", gate: "#d29922", neutral: "#8b949e" };
const BIN = () => `${home()}/.claude/herdr/bin/herdr-board`;
const repoShort = (r) => (r ?? "").split("/").pop();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Copied from mods/board-strip/main.js. After a worktree is removed: end every terminal that was
// running in it. A tab whose panes all lived there closes whole, a space whose folder was the
// worktree closes once nothing else is in it, and a pane sharing a tab with other work closes alone.
function closeWorktreeTabs(path, knownPanes) {
  const known = new Set(knownPanes);
  const all = panes();
  const doomed = (pn) => known.has(pn.pane) || inside(pn.cwd, path);
  const tabsClosed = new Set();
  for (const tabId of new Set(all.filter(doomed).map((pn) => pn.tab))) {
    const inTab = all.filter((pn) => pn.tab === tabId && pn.terminal);
    if (inTab.every(doomed)) { run("tab.close", { id: tabId, confirmed: true }); tabsClosed.add(tabId); }
    else inTab.filter(doomed).forEach((pn) => run("pane.close", { pane: pn.pane }));
  }
  for (const sp of spaces()) {
    if (!inside(sp.folder, path)) continue;
    const left = sp.tabs.filter((tab) => !tabsClosed.has(tab.id) && all.some((pn) => pn.tab === tab.id && pn.terminal && !doomed(pn)));
    // Closing a space's last tab already closes the space; a second close would fail.
    if (sp.tabs.every((tab) => tabsClosed.has(tab.id))) continue;
    if (!left.length) run("space.close", { id: sp.id, confirmed: true });
  }
}

export default class Stage extends View {
  init(_props, cx) {
    this.dir = `${home()}/.claude/herdr`;
    this.cards = {};
    this.reviews = [];
    this.seatSpaces = [];
    this.key = undefined; // the active target's key; undefined until the first sync
    this.target = null;
    this.gen = 0;
    this.docs = { specs: [], plans: [] };
    this.progress = null;
    this.docText = new Map(); // path → { mtime, text }
    this.docPick = {}; // { Spec: path, Plan: path } chosen in the picker
    this.unseenBefore = new Map(); // card path → Set of unseen doc paths at the last scan
    this.prPick = new Map(); // card path → "repo#number"
    this.issue = null; // { key, entity }
    this.pr = null; // { key, entity }
    this.runs = new Map(); // run id → { data, at, error }
    this.appliedAt = 0;
    this.busy = null;

    cx.spawn(async (cx) => {
      await this.read();
      this.sync(cx);
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        await this.read();
        this.sync(cx, true);
        if (this.target?.kind === "card") this.scan(cx, this.gen);
        cx.notify();
      }
    });
    cx.timer.every(SYNC_MS, (cx) => this.sync(cx));
    cx.timer.every(DOCS_MS, (cx) => { if (this.target?.kind === "card") this.scan(cx, this.gen); });
    cx.timer.every(5000, (cx) => this.refreshRuns(cx));
    cx.timer.every(60000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.toggle(cx);
        cx.notify();
      }
    });
  }

  // ---------- data ----------

  async read() {
    try {
      const text = await readTextFile(`${this.dir}/board.json`);
      this.cards = (text ? JSON.parse(text) : {}).cards ?? {};
      this.readError = null;
    } catch {
      this.readError = "board.json could not be read";
    }
    try { this.reviews = JSON.parse((await readTextFile(`${this.dir}/reviews.json`)) ?? "{}").prs ?? []; } catch { /* keep the last list */ }
    try {
      const seats = JSON.parse((await readTextFile(`${this.dir}/seats.json`)) ?? "{}").seats ?? [];
      this.seatSpaces = seats.map((s) => s.space).filter(Boolean);
    } catch { /* keep the last list */ }
    try { this.org = JSON.parse((await readTextFile(`${this.dir}/config.json`)) ?? "{}").org ?? ""; } catch { /* keep the last one */ }
  }

  // What the active space shows, from live spaces/panes and the last board read.
  resolve() {
    const space = spaces().find((s) => s.active) ?? null;
    if (!space) return { space: null, target: null };
    const tabIds = new Set(space.tabs.map((tab) => tab.id));
    const spacePanes = panes().filter((p) => tabIds.has(p.tab));
    return { space, target: activeTarget({ space, spacePanes, cards: this.cards, seatSpaces: this.seatSpaces, reviews: this.reviews, org: this.org ?? "" }) };
  }

  keyOf(target) {
    if (!target) return null;
    return target.kind === "card" ? `card:${target.card.path}` : `review:${target.repo}#${target.number}`;
  }

  // Runs every SYNC_MS and after each board read: follow the active space, keep the block's
  // visibility in step, and keep the shown view's nested Issue/PR entity pointed at it.
  sync(cx, force = false) {
    const { space, target } = this.resolve();
    this.space = space;
    const key = this.keyOf(target);
    const changed = key !== this.key;
    this.target = target;
    // The tab bar's stage toggle greys out where there is nothing to show.
    const available = target?.kind === "card" || target?.kind === "review";
    if (shared("stage.available") !== available) setShared("stage.available", available);
    if (changed) this.retarget(cx, key);
    this.applyVisibility();
    this.ensureViews(cx);
    if (this.visible() && this.tab() !== null) this.markSeen();
    // The gate banner reads shared "ci.gates", which strip-tabs rewrites on each poll.
    const gatesAt = JSON.stringify(shared("ci.gates")?.gates ?? []);
    const gatesChanged = gatesAt !== this.gatesAt;
    this.gatesAt = gatesAt;
    if (changed || force || gatesChanged) cx.notify();
  }

  retarget(cx, key) {
    this.key = key;
    this.gen += 1;
    this.docs = { specs: [], plans: [] };
    this.progress = null;
    this.docPick = {};
    this.scanned = false;
    if (this.issue) { this.issue.entity.release(); this.issue = null; }
    if (this.pr) { this.pr.entity.release(); this.pr = null; }
    if (this.target?.kind !== "card") return;
    const gen = this.gen;
    const wt = this.target.card.path;
    this.scan(cx, gen);
    // Live: specs/plans and the sdd ledgers. A folder that does not exist yet rejects the watch;
    // the DOCS_MS rescan finds it once it appears.
    for (const dir of [`${wt}/docs/superpowers`, `${wt}/.superpowers`]) {
      cx.spawn(async (cx) => {
        while (gen === this.gen) {
          try { await watchFolder(dir); } catch { await cx.sleep(DOCS_MS); continue; }
          if (gen !== this.gen) return;
          await this.scan(cx, gen);
        }
      });
    }
  }

  // ---------- visibility ----------

  visible() {
    return stageVisible({ card: this.target?.kind === "card", isTeamReview: this.target?.kind === "review", manualHidden: shared("stage.manualHidden") === true });
  }

  // cmd-shift-\ is `layout.toggle:stage` in keys.json, not a stage.* command: a hidden copy
  // gets no mod commands, so a mod command could hide the column but never bring it back.
  // A show or hide this copy did not make is read as that key (or a click) and kept as
  // stage.manualHidden, so the automatic show/hide below does not undo it.
  applyVisibility() {
    const node = find(layout(), "stage");
    if (!node) return;
    const shown = !node.hidden;
    // Right after our own show/hide, layout() may still report the old state: wait it out.
    if (Date.now() - this.appliedAt < 1500) return;
    if (this.lastShown !== undefined && shown !== this.lastShown) {
      const manual = shared("stage.manualHidden") === true;
      if (!shown && !manual && this.target) setShared("stage.manualHidden", true);
      if (shown && manual) setShared("stage.manualHidden", false);
    }
    this.lastShown = shown;
    const want = this.visible();
    if (want === shown) return;
    this.appliedAt = Date.now();
    this.lastShown = want;
    run(want ? "layout.show" : "layout.hide", { id: "stage" });
  }

  toggle(cx) {
    setShared("stage.manualHidden", !(shared("stage.manualHidden") === true));
    this.applyVisibility();
    cx.notify();
  }

  // ---------- docs and progress ----------

  async scan(cx, gen) {
    const card = this.target?.kind === "card" ? this.target.card : null;
    if (!card || gen !== this.gen) return;
    const wt = card.path;
    const r = await exec("find", [
      `${wt}/docs/superpowers/specs`, `${wt}/docs/superpowers/plans`, `${wt}/.superpowers/sdd`,
      "-maxdepth", "2", "-type", "f", "(", "-name", "*.md", "-o", "-name", "plan-path", ")",
      "-exec", "stat", "-f", "%m %N", "{}", "+",
    ], { timeout: 10000 }).catch(() => null);
    if (gen !== this.gen) return;
    // mtime in ms since the epoch, the unit stage.seen records.
    const entries = [];
    for (const line of (r?.stdout ?? "").split("\n")) {
      const m = /^(\d+) (.+)$/.exec(line);
      if (m) entries.push({ path: m[2], mtime: Number(m[1]) * 1000 });
    }
    const docs = discoverDocs(entries);
    this.docs = docs;
    this.progress = await this.readProgress(wt, docs, entries);
    if (gen !== this.gen) return;

    // A spec or plan new or changed since it was last viewed: switch to it on its own.
    const unseen = unseenDocs(docs, shared("stage.seen") ?? {});
    const fresh = newlyUnseen(this.unseenBefore.get(wt) ?? null, unseen, docs);
    this.unseenBefore.set(wt, unseen);
    if (fresh) {
      const kind = docKind(fresh);
      this.docPick[kind] = fresh;
      this.saveTab(card, kind);
    }
    await this.loadDocText();
    this.scanned = true;
    this.ensureViews(cx);
    if (this.visible()) this.markSeen();
    cx.notify();
  }

  // The plan's tasks and the ledger found through each sdd folder's plan-path marker.
  async readProgress(wt, docs, entries) {
    const markers = [];
    for (const e of entries.filter((x) => x.path.startsWith(`${wt}/.superpowers/sdd/`) && x.path.endsWith("/plan-path"))) {
      const text = await readTextFile(e.path).catch(() => null);
      if (text?.trim()) markers.push({ dir: e.path.slice(0, -"/plan-path".length), planPath: text.trim() });
    }
    let planAbs = docs.plans[0]?.path ?? null;
    let ledgerPath = planAbs ? resolveLedger(wt, planAbs, markers) : null;
    if (!planAbs && markers.length) {
      // No plan in the worktree: the plan lives elsewhere; take the ledger written last.
      const mt = (d) => entries.find((x) => x.path === `${d}/progress.md`)?.mtime ?? 0;
      const m = [...markers].sort((a, b) => mt(b.dir) - mt(a.dir))[0];
      planAbs = m.planPath.startsWith("/") ? m.planPath : `${wt}/${m.planPath}`;
      ledgerPath = `${m.dir}/progress.md`;
    }
    if (!planAbs) return null;
    const tasks = parsePlanTasks(await readTextFile(planAbs).catch(() => null));
    const ledgerText = ledgerPath ? await readTextFile(ledgerPath).catch(() => null) : null;
    const ledger = ledgerText != null ? parseLedger(ledgerText) : null;
    const ledgerMtime = ledgerPath ? entries.find((x) => x.path === ledgerPath)?.mtime ?? null : null;
    return { planAbs, ledgerPath: ledger ? ledgerPath : null, tasks, ledger, ledgerMtime, ...progressOf(tasks, ledger) };
  }

  docsOf(kind) {
    return kind === "Spec" ? this.docs.specs : kind === "Plan" ? this.docs.plans : [];
  }

  shownDoc(kind) {
    const list = this.docsOf(kind);
    return list.find((d) => d.path === this.docPick[kind]) ?? list[0] ?? null;
  }

  async loadDocText() {
    const tab = this.tab();
    const doc = tab === "Spec" || tab === "Plan" ? this.shownDoc(tab) : null;
    if (!doc) return;
    const have = this.docText.get(doc.path);
    if (have && have.mtime === doc.mtime) return;
    const text = await readTextFile(doc.path).catch(() => null);
    this.docText.set(doc.path, { mtime: doc.mtime, text: text ?? "" });
  }

  // Viewing a spec or plan records its mtime, which clears its dot here and its chip on the card.
  markSeen() {
    const tab = this.tab();
    if (tab !== "Spec" && tab !== "Plan") return;
    const doc = this.shownDoc(tab);
    if (!doc || !this.docText.has(doc.path)) return;
    const seen = shared("stage.seen") ?? {};
    if (seen[doc.path] === doc.mtime) return;
    setShared("stage.seen", { ...seen, [doc.path]: doc.mtime });
    this.unseenBefore.get(this.target?.card?.path)?.delete(doc.path);
  }

  // ---------- tabs ----------

  family() {
    return this.target?.kind === "card" ? familyPrs(this.target.card, this.cards) : [];
  }

  avail() {
    const t = this.target;
    if (!t) return [];
    if (t.kind === "review") return ["PR"];
    const list = availableTabs(t.card, this.docs, this.family());
    // A plan kept outside the worktree still has a ledger here.
    if (this.progress?.tasks?.length && !list.includes("Progress")) list.push("Progress");
    // Remove worktree lives on CI, and it is offered as soon as the card is Done.
    if (t.card.stage === "done" && !list.includes("CI")) list.push("CI");
    return TABS.filter((x) => list.includes(x));
  }

  tab() {
    const t = this.target;
    if (!t) return null;
    if (t.kind === "review") return "PR";
    const c = t.card;
    return chooseTab({ stage: c.stage, from: c.pending?.from, avail: this.avail(), saved: (shared("stage.tab") ?? {})[c.path], defaultTab });
  }

  saveTab(card, tab) {
    setShared("stage.tab", { ...(shared("stage.tab") ?? {}), [card.path]: { tab, stage: card.stage } });
  }

  pick(tab, cx) {
    if (this.target?.kind !== "card") return;
    this.saveTab(this.target.card, tab);
    cx.spawn(async (cx) => { await this.loadDocText(); this.ensureViews(cx); if (this.visible()) this.markSeen(); cx.notify(); });
    cx.notify();
  }

  // The PR the PR tab shows: a review space's PR, or the card family's picked or default PR.
  currentPr() {
    const t = this.target;
    if (!t) return null;
    if (t.kind === "review") return { repo: t.repo, number: t.number, own: false };
    const fam = this.family();
    const picked = this.prPick.get(t.card.path);
    return fam.find((p) => `${p.repo}#${p.number}` === picked) ?? defaultPr(t.card, fam);
  }

  // Nested Issue/PR views are made outside render (GPUI forbids it there) and only for the tab
  // on show, then kept until the target changes.
  ensureViews(cx) {
    const tab = this.tab();
    const t = this.target;
    if (tab === "Issue" && t?.kind === "card" && t.card.issue) {
      const key = `${t.card.repo}#${t.card.issue}`;
      if (this.issue?.key !== key) {
        this.issue?.entity.release();
        this.issue = { key, entity: cx.new(IssueView, { repo: t.card.repo, issue: t.card.issue }) };
        cx.notify();
      }
    }
    if (tab === "PR") {
      const p = this.currentPr();
      const key = p ? `${p.repo}#${p.number}` : null;
      if (key && this.pr?.key !== key) {
        this.pr?.entity.release();
        this.pr = { key, entity: cx.new(PrView, { repo: p.repo, number: p.number }) };
        cx.notify();
      }
    }
  }

  // ---------- actions ----------

  // A parked card: open Claude in this space with herdr-q's orient-and-plan prompt, and move a
  // TODO card to Planning.
  startSession(cx) {
    const card = this.target?.card;
    const space = this.space;
    if (!card || !space || this.busy) return;
    this.busy = "start";
    cx.notify();
    cx.spawn(async (cx) => {
      run("tab.new", { space: space.id, folder: card.path, argv: ["claude"], task: planPrompt(card, this.org ?? "") });
      if (card.stage === "claimed") {
        const s = await exec(BIN(), ["set", card.path, "--stage", "planning", "--why", "session started from the stage column"]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (s.code !== 0) notify({ title: "Card not moved to Planning", body: (s.stderr || s.stdout || "").trim(), level: "error" });
      }
      this.busy = null;
      cx.notify();
    });
  }

  // Code review always gets its own Claude tab, `Review #<n>`; an open one is selected instead.
  codeReview(p) {
    const space = this.space;
    if (!space || !p) return;
    const name = `Review #${p.number}`;
    const open = space.tabs.find((tab) => tab.name === name);
    if (open) return run("tab.select", { id: open.id });
    run("tab.new", { space: space.id, name, folder: p.path ?? this.target?.card?.path, argv: ["claude"], task: `/code-review:code-review ${p.number}` });
  }

  // Copied from mods/board-strip/main.js: Herdr's own Remove worktree dialog, children first,
  // one dialog each. Never gated on CI. board-strip watches `board.removing`, drops each card once
  // its folder is gone and opens the next dialog.
  removeWorktree(p) {
    if (!p.solo && p.next === undefined) {
      const kids = Object.values(this.cards ?? {}).filter((c) => c.parent === p.path);
      if (kids.length) {
        const rest = [...kids.slice(1).map((k) => ({ path: k.path, repo: k.repo, issue: p.issue })), { path: p.path, repo: p.repo, issue: p.issue, spaceId: p.spaceId, next: [] }];
        return this.removeWorktree({ path: kids[0].path, repo: kids[0].repo, issue: p.issue, next: rest });
      }
    }
    const next = p.next ?? [];
    exec("test", ["-e", p.path]).then(async (gone) => {
      if (gone.code !== 0) {
        closeWorktreeTabs(p.path, []);
        await exec(BIN(), ["rm", p.path]);
        if (next.length) this.removeWorktree({ ...next[0], next: next.slice(1) });
        return;
      }
      let id = p.spaceId;
      if (!id) {
        const r = await exec("herdr-app", ["do", "space.new", JSON.stringify({ folder: p.path, name: `${(p.repo ?? "").split("/").pop()} #${p.issue ?? ""}`.trim() })]);
        try { id = JSON.parse(r.stdout).space; } catch { id = null; }
        if (!id) return notify({ title: "Could not open Remove worktree", body: (r.stderr || r.stdout).trim(), level: "error" });
      }
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: id, folder: p.path, action: "remove" } });
      const inWorktree = panes().filter((pn) => inside(pn.cwd, p.path)).map((pn) => pn.pane);
      setShared("board.removing", { ...(shared("board.removing") ?? {}), [p.path]: { until: Date.now() + 5 * 60 * 1000, panes: inWorktree, next } });
    });
  }

  // Post-merge CI: each run's jobs, fetched while the CI tab shows; again every CI_MS until done.
  refreshRuns(cx) {
    if (this.tab() !== "CI" || !this.visible() || this.runsBusy) return;
    const want = [];
    for (const p of mergedNewestFirst(this.family())) {
      for (const run of p.merge_ci?.runs ?? []) {
        const id = runIdOf(run.url);
        if (!id) continue;
        const have = this.runs.get(id);
        const done = have?.data && stateOf(have.data).done;
        if (!have || (!done && Date.now() - have.at > CI_MS)) want.push({ id, repo: p.repo });
      }
    }
    if (!want.length) return;
    this.runsBusy = true;
    cx.spawn(async (cx) => {
      for (const w of want) {
        const r = await exec("gh", ["run", "view", w.id, "--repo", w.repo, "--json", "status,conclusion,createdAt,updatedAt,jobs"], { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
        try {
          if (r.code !== 0) throw new Error((r.stderr || "gh run view failed").trim());
          this.runs.set(w.id, { data: JSON.parse(r.stdout), at: Date.now(), error: null });
        } catch (e) {
          this.runs.set(w.id, { ...(this.runs.get(w.id) ?? {}), at: Date.now(), error: String(e.message ?? e) });
        }
      }
      this.runsBusy = false;
      cx.notify();
    });
  }

  // ---------- pieces ----------

  button(t, id, label, onClick, style = "plain") {
    const solid = { green: "#238636", red: null }[style];
    const fg = solid ? "#ffffff" : style === "red" ? t.blocked : t.foreground;
    return h_flex().id(id).flex_none().px(10).h(28).gap(6).rounded(6).border_1().border_color(solid ?? (style === "red" ? t.blocked + "88" : t.border))
      .bg(solid ?? (style === "red" ? t.blocked + "1a" : t.raised)).text_size(12).font_medium().text_color(fg).items_center().cursor_pointer()
      .hover((s) => s.opacity(0.88)).when(Boolean(onClick), (el) => el.on_click(onClick))
      .when(style === "red", (el) => el.child(svg(icon("trash-2")).size(13).text_color(fg)))
      .child(label);
  }

  bar(t, children) {
    return h_flex().flex_none().w_full().px(12).py(8).gap(8).items_center().flex_wrap().border_b(1).border_color(t.border).bg(t.surface).children(children);
  }

  chipBtn(t, id, label, on, onClick, dot = false) {
    return h_flex().id(id).flex_none().px(8).h(24).gap(5).rounded(6).items_center().text_size(11.5).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "1f" : t.background)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().max_w(260).truncate().child(label))
      .when(dot, (el) => el.child(div().size(6).flex_none().rounded(3).bg("#3b82f6")));
  }

  header(t, tab, avail, unseen) {
    const dotFor = (kind) => [...unseen].some((p) => docKind(p) === kind);
    const tgt = this.target;
    const context = !tgt ? "" : tgt.kind === "review"
      ? `Team review · ${repoShort(tgt.repo)} #${tgt.number}`
      : `${STAGE_NAME[tgt.card.stage] ?? tgt.card.stage} · ${repoShort(tgt.card.repo)}${tgt.card.issue ? ` #${tgt.card.issue}` : ""}`;
    return h_flex().id("stage-head").flex_none().h(HEAD).w_full().px(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .children(TABS.map((name) => {
        const ok = avail.includes(name);
        const on = name === tab;
        return h_flex().id(`st-tab-${name}`).flex_none().px(10).h(26).gap(5).rounded(6).items_center().text_size(12)
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : ok ? t.muted : t.dim)
          .when(!ok, (el) => el.opacity(0.45))
          .when(ok && !on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.pick(name, cx)))
          .child(name)
          .when(ok && (name === "Spec" || name === "Plan") && dotFor(name), (el) => el.child(div().size(6).rounded(3).bg("#3b82f6")));
      }))
      .child(div().flex_1().min_w(0).px(8).truncate().text_right().text_size(11.5).text_color(t.dim).child(context));
  }

  empty(t, text) {
    return div().flex_1().min_h(0).p(24).flex().items_center().justify_center().text_size(13).text_color(t.dim).child(text);
  }

  issueBody(t) {
    const card = this.target.card;
    const space = this.space;
    const hasClaude = space && agents().some((a) => a.space === space.id && (a.program?.key === "claude" || /claude/i.test(a.app ?? "")));
    return v_flex().flex_1().min_h(0)
      .when(!hasClaude, (el) => el.child(this.bar(t, [
        div().flex_1().min_w(0).text_size(12.5).text_color(t.muted).child("No Claude session in this space."),
        this.button(t, "st-start", this.busy === "start" ? "Starting…" : "Start session", (_e, cx) => this.startSession(cx), "green"),
      ])))
      .child(this.issue ? div().flex_1().min_h(0).child(this.issue.entity) : this.empty(t, card.issue ? "Loading issue…" : "This card has no issue."));
  }

  docBody(t, kind, unseen) {
    const list = this.docsOf(kind);
    const doc = this.shownDoc(kind);
    if (!doc) return this.empty(t, `No ${kind.toLowerCase()} yet.`);
    const wt = this.target.card.path;
    const rel = doc.path.startsWith(wt + "/") ? doc.path.slice(wt.length + 1) : doc.path;
    const loaded = this.docText.get(doc.path);
    return v_flex().flex_1().min_h(0)
      .when(list.length > 1, (el) => el.child(this.bar(t, list.map((d, i) =>
        this.chipBtn(t, `st-doc-${i}`, d.path.split("/").pop(), d.path === doc.path,
          (_e, cx) => { this.docPick[kind] = d.path; this.pick(kind, cx); }, unseen.has(d.path))))))
      .child(v_flex().id(`st-doc-scroll-${kind}`).flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(10)
        .child(div().text_size(11.5).text_color(t.dim).child(`${rel} · updated ${relTime(new Date(doc.mtime).toISOString())}`))
        .child(loaded
          ? div().text_size(13).text_color(t.foreground).child(TextView.markdown(`st-md-${doc.path}-${doc.mtime}`, loaded.text || "_Empty file._").selectable(true))
          : div().text_size(13).text_color(t.dim).child("Loading…")));
  }

  progressBody(t) {
    const p = this.progress;
    if (!p) return this.empty(t, this.scanned ? "No plan found for this worktree." : "Reading the plan…");
    const wt = this.target.card.path;
    const rel = (x) => (x?.startsWith(wt + "/") ? x.slice(wt.length + 1) : x);
    const prevDone = p.current && p.ledger && p.ledger.last && new RegExp(`^Task ${p.current - 1}: complete\\b`).test(p.ledger.last);
    const started = !p.ledger || !p.ledgerMtime ? null
      : prevDone || p.current === p.tasks[0]?.n ? `started ${relTime(new Date(p.ledgerMtime).toISOString())}` : `ledger updated ${relTime(new Date(p.ledgerMtime).toISOString())}`;
    return v_flex().id("st-progress").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(8)
      .child(div().text_size(11.5).text_color(t.dim).child(`${rel(p.planAbs)} · ${p.done}/${p.total} tasks`))
      .child(h_flex().h(4).w_full().rounded(2).bg(t.border).overflow_hidden()
        .child(div().h_full().bg("#3fb950").w(`${p.total ? Math.round((100 * p.done) / p.total) : 0}%`)))
      .children(p.tasks.map((task) => {
        const done = p.ledger?.done?.has(task.n);
        const cur = task.n === p.current;
        return v_flex().w_full().rounded(8).border_1().border_color(cur ? "#d29922" : t.border).bg(cur ? "#d2992214" : t.surface).px(10).py(7).gap(2)
          .child(h_flex().gap(8).items_center().text_size(12.5)
            .child(div().w(14).flex_none().text_color(done ? "#3fb950" : cur ? "#d29922" : t.dim).child(done ? "✓" : cur ? "●" : "○"))
            .child(div().flex_1().min_w(0).truncate().text_color(done ? t.muted : t.foreground).child(`Task ${task.n}: ${task.title}`)))
          .when(cur && Boolean(started), (el) => el.child(div().pl(22).text_size(11.5).text_color(t.dim).child(started)));
      }))
      .child(v_flex().mt(6).px(12).py(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(12)
        .child(div().text_color(t.foreground).child(p.ledger
          ? `${p.done} of ${p.total} tasks done · ${p.rulings} ruling${p.rulings === 1 ? "" : "s"}`
          : "No ledger yet: every task is open."))
        .when(Boolean(p.lastLine), (el) => el.child(div().text_color(t.muted).whitespace_normal().child(p.lastLine)))
        .when(Boolean(p.ledgerPath), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(rel(p.ledgerPath)))));
  }

  // Own gates (see isOwnGate) get Approve / Reject; each takes two clicks, the first arms for 6 s.
  // GET and POST the same pending_deployments path ci-dash uses.
  async reviewGate(g, state, cx) {
    const key = g.key ?? `${g.repo}#${g.runId}`;
    if (this.gateBusy?.has(key)) return;
    this.gateArm ??= new Map(); this.gateBusy ??= new Set();
    const armed = this.gateArm.get(key);
    if (!armed || armed.state !== state || Date.now() > armed.until) {
      this.gateArm.set(key, { state, until: Date.now() + 6000 });
      cx.notify();
      cx.timer?.after?.(6100, (c) => c.notify());
      return;
    }
    this.gateArm.delete(key);
    this.gateBusy.add(key); cx.notify();
    const label = state === "approved" ? "Approve" : "Reject";
    try {
      const api = `repos/${g.repo}/actions/runs/${g.runId}/pending_deployments`;
      const got = await exec("gh", ["api", api], { timeout: 30000 });
      if (got.code !== 0) throw new Error((got.stderr || got.stdout || `gh exited ${got.code}`).trim());
      const ids = (JSON.parse(got.stdout || "[]") || []).filter((p) => p.current_user_can_approve).map((p) => p.environment.id);
      if (!ids.length) throw new Error("no environment you can review");
      const args = ["api", "--method", "POST", "--header", "Accept: application/vnd.github+json", api,
        "-f", `state=${state}`, "-f", `comment=${state === "approved" ? "Approved" : "Rejected"} from the Herdr stage column`];
      for (const id of ids) args.push("-F", `environment_ids[]=${id}`);
      const r = await exec("gh", args, { timeout: 30000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || `gh exited ${r.code}`).trim());
      notify({ title: `${state === "approved" ? "Approved" : "Rejected"}: ${g.repo.split("/")[1]}`, body: `${g.title || g.workflow} · ${g.env || "deployment"}`, level: "info" });
    } catch (e) {
      notify({ title: `${label} failed: ${g.repo.split("/")[1]}`, body: String(e?.message ?? e).slice(0, 300), level: "error" });
    } finally {
      this.gateBusy.delete(key);
      setShared("ci.gates.refresh", Date.now());
      cx.notify();
    }
  }

  // Amber banner for deploy gates held in this repo, so the card is not merged ahead of them.
  gateBanner(t) {
    const repo = this.target?.kind === "card" ? this.target.card.repo : this.target?.repo;
    const gates = gatesForRepo(shared("ci.gates")?.gates, repo);
    if (!gates.length) return null;
    const amber = CI_COLOR.gate;
    const card = this.target?.kind === "card" ? this.target.card : null;
    const kids = card ? Object.values(this.cards).filter((k) => k.parent === card.path) : [];
    const btn = (id, g, state, label, color) => {
      const key = g.key ?? `${g.repo}#${g.runId}`;
      const busy = this.gateBusy?.has(key);
      const a = this.gateArm?.get(key);
      const armed = !busy && a?.state === state && Date.now() <= a.until;
      return div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(6).text_size(12).font_semibold().border_1().border_color(color)
        .bg(armed ? color : t.background).text_color(armed ? t.background : color)
        .when(busy, (el) => el.opacity(0.5)).when(!busy, (el) => el.cursor_pointer().on_click((_e, cx) => this.reviewGate(g, state, cx)))
        .child(busy ? "Sending…" : armed ? `Click again to ${label.toLowerCase()}` : label);
    };
    return v_flex().mx(14).mt(10).px(12).py(8).gap(6).flex_none().rounded(8).border_1().border_color(amber + "88").bg(amber + "1f")
      .children(gates.map((g, i) => {
        const own = isOwnGate(g, card, kids);
        return v_flex().gap(2)
          .child(h_flex().id(`st-gate-${i}`).gap(6).items_center().text_size(12.5).text_color(amber)
            .child("\u23F8")
            .child(div().flex_1().min_w(0).whitespace_normal().child(gateLine(g)))
            .when(own && g.canApprove, (el) => el.child(btn(`st-gate-ok-${i}`, g, "approved", "Approve", "#3fb950")).child(btn(`st-gate-no-${i}`, g, "rejected", "Reject", "#f85149")))
            .when(own && !g.canApprove, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child("waiting on another approver")))
            .when(Boolean(g.link), (el) => el.child(div().id(`st-gate-open-${i}`).flex_none().cursor_pointer().underline().on_click(() => exec("open", [g.link])).child("Open run"))))
          .child(div().text_size(11.5).text_color(t.muted).child("Let it deploy before you merge."));
      }));
  }

  prBody(t) {
    const cur = this.currentPr();
    if (!cur) return this.empty(t, "No pull request yet.");
    const isCard = this.target.kind === "card";
    const fam = this.family();
    const color = { OPEN: "#3fb950", MERGED: "#a371f7", CLOSED: "#f85149" };
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.gateBanner(t)), (el) => el.child(this.gateBanner(t)))
      .when(isCard, (el) => el.child(this.bar(t, [
        ...(fam.length > 1 ? fam.map((p, i) => this.chipBtn(t, `st-pr-${i}`, `${repoShort(p.repo)} #${p.number}${p.state ? ` · ${p.state.toLowerCase()}` : ""}`,
          p.repo === cur.repo && p.number === cur.number,
          (_e, cx) => { this.prPick.set(this.target.card.path, `${p.repo}#${p.number}`); this.ensureViews(cx); cx.notify(); }))
          : [h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
              .child(div().size(8).rounded(4).bg(color[cur.state] ?? t.dim)).child(`${repoShort(cur.repo)} #${cur.number}`)]),
        div().flex_1(),
        this.button(t, "st-code-review", "Code review", () => this.codeReview(cur)),
      ])))
      .child(this.pr ? div().flex_1().min_h(0).child(this.pr.entity) : this.empty(t, "Loading pull request…"));
  }

  ciBody(t) {
    const banner = this.gateBanner(t);
    const card = this.target.card;
    const fam = this.family();
    const merged = mergedNewestFirst(fam);
    const advisory = ciAdvisory(fam).text;
    const runRow = (p, r, i) => {
      const id = runIdOf(r.url);
      const live = id ? this.runs.get(id) : null;
      const st = stateOf(live?.data ?? r);
      const data = live?.data;
      const jobs = data?.jobs ?? [];
      return v_flex().w_full().rounded(8).border_1().border_color(st.kind === "failure" ? CI_COLOR.failure + "88" : st.done ? t.border : CI_COLOR.running + "88").overflow_hidden()
        .child(h_flex().id(`st-run-${p.number}-${i}`).px(10).h(34).gap(8).items_center().bg(t.surface)
          .when(Boolean(r.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => exec("open", [r.url])))
          .child(div().w(14).flex_none().text_color(CI_COLOR[st.kind]).child(GLYPH[st.kind] ?? "–"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.workflow ?? "workflow"))
          .child(pill(t, { label: st.label, color: CI_COLOR[st.kind], spin: st.kind === "running" }))
          .when(Boolean(data?.createdAt), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim)
            .child(duration(data.createdAt, st.done ? data.updatedAt : Date.now())))))
        .children(jobs.map((j) => {
          const js = stateOf(j);
          return h_flex().id(`st-job-${p.number}-${i}-${j.name}`).px(10).pl(32).h(28).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
            .when(Boolean(j.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => exec("open", [j.url])))
            .child(div().w(14).flex_none().text_color(CI_COLOR[js.kind]).child(GLYPH[js.kind] ?? "–"))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(j.name))
            .child(div().flex_none().text_size(11.5).text_color(js.done ? t.dim : CI_COLOR[js.kind])
              .child(j.startedAt ? `${js.done ? "" : "running "}${duration(j.startedAt, js.done ? j.completedAt : Date.now())}` : js.label));
        }))
        .when(Boolean(live?.error), (el) => el.child(div().px(10).py(6).border_t(1).border_color(t.border).text_size(11.5).text_color(t.blocked).child(live.error)));
    };
    return v_flex().id("st-ci").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
      .when(Boolean(banner), (el) => el.child(banner))
      .when(!merged.length, (el) => el.child(div().px(16).pt(16).text_size(13).text_color(t.dim).child("No merged pull request on this card.")))
      .children(merged.map((p) => {
        const ci = p.merge_ci;
        const runs = ci?.runs ?? [];
        const meta = [p.merged_at ? `merged ${relTime(p.merged_at)}` : "merged", p.base ? `push to ${p.base}` : null, p.merge_sha ? p.merge_sha.slice(0, 7) : null].filter(Boolean).join(" · ");
        return v_flex().w_full()
          .child(section(t, `${repoShort(p.repo)} #${p.number}`, runs.length, null, meta))
          .child(v_flex().px(14).pt(4).gap(6)
            .when(!runs.length, (el) => el.child(div().text_size(12.5).text_color(t.dim).child(
              !p.merge_sha ? "No merge commit recorded, so the merge's CI is unknown."
                : !ci ? "Looking for the CI run on the merge commit…"
                : `No CI run found for the merge commit${p.base ? ` on ${p.base}` : ""}.`)))
            .children(runs.map((r, i) => runRow(p, r, i))));
      }))
      .when(card.stage === "done", (el) => el.child(v_flex().mx(14).mt(16).px(12).py(10).gap(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .when(Boolean(advisory), (x) => x.child(div().text_size(12.5).text_color(CI_COLOR.running).whitespace_normal().child(advisory)))
        .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(`Worktree ${card.path}`))
        .child(h_flex().child(this.button(t, "st-remove", "Remove worktree…",
          () => this.removeWorktree({ path: card.path, repo: card.repo, issue: card.issue, spaceId: this.space?.id }), "red")))));
  }

  render(cx) {
    const t = theme();
    const tgt = this.target;
    const avail = this.avail();
    const tab = this.tab();
    const unseen = tgt?.kind === "card" ? unseenDocs(this.docs, shared("stage.seen") ?? {}) : new Set();
    let body;
    if (!tgt) body = this.empty(t, this.readError ?? "No card in this space.");
    else if (tab === "Issue") body = this.issueBody(t);
    else if (tab === "Spec" || tab === "Plan") body = this.docBody(t, tab, unseen);
    else if (tab === "Progress") body = this.progressBody(t);
    else if (tab === "PR") body = this.prBody(t);
    else if (tab === "CI") body = this.ciBody(t);
    else body = this.empty(t, "Nothing to show for this card yet.");
    return v_flex().id("root").size_full().min_h(0).bg(t.background)
      .child(this.header(t, tab, avail, unseen))
      .child(body);
  }
}
