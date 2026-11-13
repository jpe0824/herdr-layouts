// The board as a bottom strip (layout kanbandrawer). Cards come from ~/.claude/herdr/board.json
// (written only by herdr-board); live agent state comes from the terminals inside each worktree.
// A fixed left column holds Projects, the GitHub check and the seats from seats.json; then one
// column per stage, sharing the rest of the width and scrolling vertically on their own. Tall
// enough for about five cards, the stage columns become repo lanes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, panes, spaces, terminals, run, hc, theme, exec, home, readTextFile, watchFolder, notify, setAgentOrder, layout, props, openOverlay, closeOverlay, nextCommand, keys, shared, setShared, playSound } from "herdr";
import { CARD, GAP, HEAD, LEFT_COL, COUNT_W, STAGE, RANK, DONE_KEEP_MS, TAB_GAP, heightFor, snapTarget, isTall, fitChips, columnsFor, agentNeedsYou, sortRows, columnWidths, lanes, cardDot, chip as chipFor } from "./logic.js";
import { parsePlanTasks, parseLedger, progressOf, resolveLedger, discoverDocs, unseenDocs, ciAdvisory } from "./stage-logic.js";

const ICONS = "mods/board-strip/icons";
const BIN = () => `${home()}/.claude/herdr/bin/herdr-board`;
const MENU_STAGES = ["claimed", "planning", "in_progress", "in_review", "done"]; // Pending has its own dialog
const LAYOUT_SECTION = "layout:kanbandrawer";

const POLL_MS = 3 * 60 * 1000;
const DOCS_MS = 20 * 1000;
const SNAP_MS = 300;
// Strip geometry around logic.js's CARD/GAP/HEAD/PAD: PAD is 5 top + 1 border + 8 bottom.
const STRIP_PX = 10;
const COL_GAP = 8;
const LANE_LABEL = 96;
// A Needs you row is one line, half a card tall.
const NEED_ROW = Math.round(CARD / 2);

const STAGE_LOOK = {
  needs: { icon: "circle-alert", color: "blocked" },
  claimed: { icon: "circle-dashed", color: "muted" },
  planning: { icon: "lightbulb", color: "ansi5" },
  in_progress: { icon: "contrast", color: "ansi3" },
  pending: { icon: "clock", color: "ansi6" },
  in_review: { icon: "eye", color: "ansi4" },
  done: { icon: "circle-check", color: "ansi2" },
  team: { icon: "pr-open", color: "ansi4" },
  others: { icon: null, color: "dim" },
};
// GitHub's dark-theme PR colors.
const PR_COLOR = { open: "#3fb950", merged: "#a371f7", closed: "#f85149" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GLYPH = { ctrl: "⌃", cmd: "⌘", alt: "⌥", shift: "⇧" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The key bound to an action, drawn the macOS way (cmd-shift-m → ⌘⇧M). This layout's own
// section wins over a global binding of the same action.
function keyHint(action) {
  const a = action ?? "";
  const all = keys();
  const k = all.find((x) => x.section === LAYOUT_SECTION && x.action === a) ?? all.find((x) => x.action === a);
  return (k?.keys ?? "").split("-").filter(Boolean).map((p) => GLYPH[p] ?? p.toUpperCase()).join("");
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isDue = (c) => c.stage === "pending" && c.pending?.until && c.pending.until <= localDay();
const shortDate = (iso) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
// An agent's tab as the tab bar shows it: the tab's name if someone named it, else the
// session's own title, else the program.
const agentLabel = (a) => {
  if (a.tab_name && !/^\d+$/.test(a.tab_name)) return a.tab_name;
  const title = String(a.title ?? "").replace(/^[^\p{L}\p{N}#~]+/u, "").trim();
  return title && title !== a.program?.name && title !== a.address ? title : a.program?.name ?? a.tab_name;
};
// What a tab holds, by pane: viewer mods by name, terminals by program.
const MOD_KIND = {
  pr: { label: "Pull request", icon: `${ICONS}/pr-open.svg` },
  "issue-q": { label: "Issue", icon: `${ICONS}/circle-dot.svg` },
};
const TERMINAL_ICON = "mods/workspace-chrome/terminal.svg";
function tabKinds(tabId, ps) {
  const kinds = [];
  for (const p of ps) {
    if (p.tab !== tabId) continue;
    const k = p.mod
      ? { key: `mod:${p.mod}`, tint: true, ...(MOD_KIND[p.mod] ?? { label: p.title || p.mod, icon: "mods/workspace-chrome/file-text.svg" }) }
      : p.program?.shell || !p.program
      ? { key: "shell", label: "Shell", icon: TERMINAL_ICON, tint: true }
      : { key: p.program.key, label: p.program.name, icon: p.program.icon ?? TERMINAL_ICON, tint: p.program.icon ? p.program.tint : true };
    if (!kinds.some((x) => x.key === k.key)) kinds.push(k);
  }
  return kinds;
}

const inside = (p, dir) => !!p && (p === dir || p.startsWith(dir + "/"));
const repoName = (c) => (c.repo ?? "").split("/").pop() || "repo";
// Every PR a card's worktree opened (a session can open several), oldest first.
const prsOf = (c) => (c.prs?.length ? c.prs : c.pr?.number ? [c.pr] : []);
// Parent path → its child cards. A child whose parent card is gone is not listed here.
function childrenOf(cards) {
  const m = new Map();
  for (const c of Object.values(cards)) {
    if (c.parent && cards[c.parent]) m.set(c.parent, [...(m.get(c.parent) ?? []), c]);
  }
  return m;
}
// Width a card's tab row can use: the card's width (a column's, or the left column's) less padding and border.
const rowWidth = (w) => Math.max(0, (typeof w === "number" ? w : LEFT_COL) - 18);
const seatTerminal = (s) => `seat-${s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`.slice(0, 32);
const mostUrgent = (list) => list.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m?.status] ?? 0) ? a : m), null);

// After a worktree is removed: end every terminal that was running in it, in any space.
// A tab whose panes all lived there closes whole, a space whose folder was the worktree
// closes once nothing else is in it, and a pane sharing a tab with other work closes alone.
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

export default class BoardStrip extends View {
  init(_props, cx) {
    // Overlay copies: a card's right-click menu and the Pending dialog.
    if (props()?.menu) return this.initMenu(cx);
    if (props()?.pendingDialog) return this.initDialog(cx);
    this.cards = {};
    this.seats = [];
    this.reviews = [];
    this.synced = null;
    this.errors = [];
    this.syncing = false;
    this.docs = new Map();
    this.docsBusy = false;
    this.size = null;
    this.sizeSeq = 0;
    this.dir = `${home()}/.claude/herdr`;
    this.bin = `${this.dir}/bin/herdr-board`;
    try { this.dueToasted = JSON.parse(localStorage.getItem("dueToasted") ?? "{}"); } catch { this.dueToasted = {}; }
    // A height saved under older card sizes is re-snapped, so it can never sit below two cards.
    try { const v = Number(localStorage.getItem("lastShort")); this.lastShort = v ? snapTarget(v) : null; } catch { this.lastShort = null; }
    this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        await this.read();
        this.refreshDocs(cx);
        cx.notify();
      }
    });
    // This layout's only GitHub poll: the stage column and Projects read what it writes.
    cx.timer.every(POLL_MS, (cx) => { this.syncNow(cx); });
    cx.timer.every(DOCS_MS, (cx) => this.refreshDocs(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        await this.command(c);
        cx.notify();
      }
    });
    cx.timer.every(30000, (cx) => cx.notify());
    // Worktrees sent to Remove worktree (here, or from the stage column): drop the card once
    // the folder is gone.
    cx.timer.every(2000, (cx) => {
      const watching = shared("board.removing") ?? {};
      if (!Object.keys(watching).length) return;
      cx.spawn(async () => {
        const left = { ...watching };
        for (const [path, entry] of Object.entries(watching)) {
          const until = typeof entry === "number" ? entry : entry?.until ?? 0;
          const r = await exec("test", ["-e", path]);
          if (r.code !== 0) {
            delete left[path];
            closeWorktreeTabs(path, entry?.panes ?? []);
            const rm = await exec(this.bin, ["rm", path]);
            if (rm.code === 0) notify({ title: "Worktree removed", body: path.split("/").pop(), level: "success" });
            const next = entry?.next ?? [];
            if (next.length) this.removeWorktree({ ...next[0], next: next.slice(1) });
          } else if (Date.now() > until) delete left[path];
        }
        if (Object.keys(left).length !== Object.keys(watching).length) setShared("board.removing", left);
      });
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      await this.read();
      this.refreshDocs(cx);
      cx.notify();
      if (!this.synced) await this.syncNow(cx);
    });
  }

  // ---------- commands (keys.json `board-strip.<name>`, seats, toasts) ----------

  async command(c) {
    if (c === "projects") return this.toggleProjects();
    if (c === "reviews") {
      run("layout.select", { stack: "panel-body", child: "reviews" });
      run("layout.show", { id: "panel" });
      return;
    }
    const name = `board-strip.${c}`;
    // A seat's one-click command bound in keys.json.
    const seat = this.seats.find((s) => s.command?.action === name);
    if (seat) return this.runSeatCommand(seat);
    // A space seat's key: a new terminal tab in its space.
    const spaceSeat = this.seats.find((s) => s.space && s.action === name);
    if (spaceSeat) this.newSeatTab(spaceSeat);
  }

  // A board-strip.* action names this mod: handle it here. Anything else is an app command.
  runAction(action) {
    if (action.startsWith("board-strip.")) return this.command(action.slice("board-strip.".length));
    run(action);
  }

  // Projects (its key): show the panel on Projects, or hide it when Projects is already showing.
  toggleProjects() {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return notify({ title: "Projects isn't in this layout" });
    if (!panel.hidden && body.active === "projects") return run("layout.hide", { id: "panel" });
    run("layout.show", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "projects" });
  }

  // Seats: fixed places for work that is not a card. From ~/.claude/herdr/seats.json.
  async readSeats() {
    try {
      const text = await readTextFile(`${this.dir}/seats.json`);
      const h = home();
      this.seats = (text ? JSON.parse(text).seats ?? [] : []).map((s) => ({ ...s, folder: String(s.folder ?? "~").replace(/^~(?=\/|$)/, h) }));
    } catch {
      this.seats = [];
    }
  }

  // A seat's one-click command: typed into the seat's Claude session, or the first message of
  // a new one. A session waiting on an answer is shown, not typed into.
  runSeatCommand(s) {
    if (s.command?.run) return this.runAction(s.command.run);
    const cmd = s.command?.send;
    if (!cmd) return;
    const cwdOf = new Map(panes().map((p) => [p.pane, p.cwd]));
    const seatSpace = s.space ? spaces().find((sp) => sp.name === s.space) : null;
    const mine = agents().filter((a) => (s.space ? Boolean(seatSpace) && a.space === seatSpace.id : inside(cwdOf.get(a.pane), s.folder)));
    const blocked = mine.find((a) => a.status === "blocked");
    if (blocked) {
      run("pane.focus", { pane: blocked.pane });
      return notify({ title: `${s.name} is waiting on an answer`, body: `Answer it, then run ${s.command.label ?? cmd} again.`, level: "warning" });
    }
    const target = mine.find((a) => a.status !== "working") ?? mine[0];
    if (target) {
      run("pane.focus", { pane: target.pane });
      return hc(["send", target.address, cmd]).then((r) => {
        if (r.code !== 0) notify({ title: `Could not send ${cmd}`, body: (r.stderr || r.stdout).trim(), level: "error" });
      });
    }
    if (seatSpace) {
      run("space.select", { id: seatSpace.id });
      return run("tab.new", { space: seatSpace.id, folder: s.folder, argv: s.argv?.length ? s.argv : ["claude"], task: cmd });
    }
    run("space.new", { name: s.space ?? s.name, folder: s.folder, argv: s.argv?.length ? s.argv : ["claude"], task: cmd });
  }

  openSeat(s, lead) {
    if (lead) return run("pane.focus", { pane: lead.pane });
    const existing = s.space && spaces().find((sp) => sp.name === s.space);
    if (existing) return run("space.select", { id: existing.id });
    run("space.new", { name: s.space ?? s.name, folder: s.folder, ...(s.argv?.length ? { argv: s.argv } : {}) });
  }

  // A new tab in a space seat's space, making the space if it's gone.
  newSeatTab(s) {
    const existing = spaces().find((sp) => sp.name === s.space);
    const argv = s.argv?.length ? { argv: s.argv } : {};
    if (!existing) return run("space.new", { name: s.space, folder: s.folder, ...argv });
    run("space.select", { id: existing.id });
    run("tab.new", { space: existing.id, folder: s.folder, ...argv });
  }

  // ---------- data ----------

  async read() {
    await this.readSeats();
    try {
      const text = await readTextFile(`${this.dir}/board.json`);
      const data = text ? JSON.parse(text) : { cards: {} };
      this.cards = data.cards ?? {};
      this.synced = data.synced ?? this.synced;
      this.readError = null;
    } catch {
      this.readError = "board.json could not be read";
    }
    try { this.reviews = JSON.parse((await readTextFile(`${this.dir}/reviews.json`)) ?? "{}").prs ?? []; } catch { /* keep the last list */ }
  }

  sync(cx) {
    cx.spawn(async (cx) => this.syncNow(cx));
  }

  async syncNow(cx) {
    if (this.syncing) return;
    this.syncing = true;
    cx.notify();
    try {
      const r = await exec(this.bin, ["sync", "--json"], { timeout: 180000 });
      if (r.code === 0) {
        const out = JSON.parse(r.stdout);
        this.errors = out.errors ?? [];
        for (const m of out.moves ?? []) {
          notify({
            title: `${(m.repo ?? "").split("/").pop()} #${m.issue ?? ""} → ${STAGE[m.stage] ?? m.stage}`,
            body: `${m.title ?? ""} (${m.why})`,
            level: m.stage === "done" ? "success" : "info",
          });
        }
      } else {
        this.errors = [{ error: (r.stderr || r.stdout || "herdr-board sync failed").trim() }];
      }
    } catch (e) {
      this.errors = [{ error: String(e) }];
    }
    await this.syncReviews();
    this.syncing = false;
    await this.read();
    cx.notify();
  }

  // Team PRs: refresh reviews.json and toast each PR the first time it shows up.
  async syncReviews() {
    try {
      const r = await exec(this.bin, ["reviews", "--json"], { timeout: 180000 });
      if (r.code !== 0) return;
      const out = JSON.parse(r.stdout);
      const notified = shared("reviews.notified");
      const known = new Set(notified ?? []);
      const fresh = out.keys.filter((k) => !known.has(k));
      if (notified && fresh.length) {
        const text = await readTextFile(`${this.dir}/reviews.json`);
        const prs = (JSON.parse(text ?? "{}").prs ?? []).filter((p) => fresh.includes(p.key));
        const toasts = prs.length > 2
          ? [{ title: `${prs.length} PRs waiting on your review`, body: [...new Set(prs.map((p) => p.repo.split("/").pop()))].join(", ") }]
          : prs.map((p) => ({ title: `Review: ${p.repo.split("/").pop()} #${p.number}`, body: `${p.title} · ${p.author}` }));
        for (const n of toasts) notify({ ...n, level: "info", action: { name: "board-strip.reviews" } });
        playSound("blocked");
      }
      if (!notified || fresh.length) setShared("reviews.notified", [...known, ...fresh].slice(-500));
    } catch {
      // Reviews are best effort.
    }
  }

  // Specs, plans and ledgers behind the chips, for Planning and In progress cards only.
  // Read on board changes and every DOCS_MS; one `find` per such card.
  refreshDocs(cx) {
    if (this.docsBusy) return;
    this.docsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const want = Object.values(this.cards).filter((c) => c.path && !(c.parent && this.cards[c.parent]) && (c.stage === "planning" || c.stage === "in_progress"));
        const next = new Map();
        for (const c of want) next.set(c.path, await this.cardDocs(c));
        this.docs = next;
      } catch {
        // Chips fall back to the board's detail until the next read.
      } finally {
        this.docsBusy = false;
        cx.notify();
      }
    });
  }

  async cardDocs(c) {
    const wt = c.path;
    const r = await exec("find", [
      `${wt}/docs/superpowers/specs`, `${wt}/docs/superpowers/plans`, `${wt}/.superpowers/sdd`,
      "-maxdepth", "2", "-type", "f", "(", "-name", "*.md", "-o", "-name", "plan-path", ")",
      "-exec", "stat", "-f", "%m %N", "{}", "+",
    ], { timeout: 10000 }).catch(() => null);
    // mtime in ms since the epoch, the unit stage.seen records.
    const entries = [];
    for (const line of (r?.stdout ?? "").split("\n")) {
      const m = /^(\d+) (.+)$/.exec(line);
      if (m) entries.push({ path: m[2], mtime: Number(m[1]) * 1000 });
    }
    const docs = discoverDocs(entries);
    const out = { docs, progress: null };
    if (c.stage !== "in_progress") return out;
    // The ledger is found through each sdd folder's plan-path marker, never by folder name.
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
    if (!planAbs) return out;
    const tasks = parsePlanTasks(await readTextFile(planAbs).catch(() => null));
    const ledger = ledgerPath ? parseLedger(await readTextFile(ledgerPath).catch(() => null)) : null;
    out.progress = progressOf(tasks, ledger);
    return out;
  }

  // Pending cards reaching their date toast once per date.
  toastDue(list) {
    let dirty = false;
    for (const c of list.filter(isDue)) {
      if (this.dueToasted[c.path] === c.pending.until) continue;
      this.dueToasted[c.path] = c.pending.until;
      dirty = true;
      notify({ title: `Check in: ${repoName(c)} #${c.issue ?? ""}`, body: `${c.title ?? c.branch} · waiting on ${c.pending.for}`, level: "warning" });
    }
    if (dirty) try { localStorage.setItem("dueToasted", JSON.stringify(this.dueToasted)); } catch {}
  }

  // ---------- height ----------

  // Herdr reports sizes only while the edge is dragged, so the snap waits for SNAP_MS of quiet.
  // A hidden strip (cmd-j) is never snapped, so showing it again keeps the height it had.
  onSize(size, cx) {
    if (find(layout(), "strip")?.hidden || !(size?.height > 0)) return;
    const changed = !this.size || Math.round(this.size.height) !== Math.round(size.height);
    this.size = size;
    cx.notify();
    if (!changed) return;
    const seq = ++this.sizeSeq;
    cx.timer.after(SNAP_MS, (cx) => {
      if (seq !== this.sizeSeq || !this.size || find(layout(), "strip")?.hidden) return;
      const px = Math.round(this.size.height);
      const target = snapTarget(px);
      if (!isTall(target) && target !== this.lastShort) {
        this.lastShort = target;
        try { localStorage.setItem("lastShort", String(target)); } catch {}
      }
      if (target !== px) run("layout.resize", { id: "strip", px: target });
      cx.notify();
    });
  }

  // ---------- right-click menus ----------

  openMenu(c, spaceId) {
    const pending = c.stage === "pending";
    const rows = MENU_STAGES.filter((s) => s !== c.stage).length + (pending ? 2 : 1) + (c.issue ? 1 : 0) + 1;
    openOverlay({
      mod: "board-strip", kind: "popup", width: 230, height: 34 + rows * 31 + 18,
      props: { menu: true, path: c.path, stage: c.stage, repo: c.repo, issue: c.issue, spaceId, pending: c.pending ?? null, title: c.title ?? "" },
    });
  }

  // The menu copy reads the cards too: Remove worktree removes a card's children first.
  initMenu(cx) {
    this.cards = {};
    cx.spawn(async () => {
      try { this.cards = JSON.parse((await readTextFile(`${home()}/.claude/herdr/board.json`)) ?? "{}").cards ?? {}; } catch {}
    });
  }

  async act(args, overlay) {
    closeOverlay(overlay);
    const r = await exec(BIN(), args);
    if (r.code !== 0) notify({ title: "Board change failed", body: (r.stderr || r.stdout).trim(), level: "error" });
  }

  menuItem(t, id, label, onClick, color) {
    return h_flex().id(id).h(31).px(8).gap(9).rounded(7).items_center()
      .text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).child(div().flex_1().child(label));
  }

  menu(t) {
    const p = props();
    const section = (text) => div().px(8).pt(6).pb(4).text_size(11).text_color(t.dim).child(text);
    const move = MENU_STAGES.filter((s) => s !== p.stage).map((s) =>
      this.menuItem(t, `mv-${s}`, STAGE[s], () => this.act(["set", p.path, "--stage", s, "--why", "moved by hand"], p.overlay)));
    const pendingItems = p.stage === "pending"
      ? [this.menuItem(t, "mv-snooze", "Snooze…", () => this.openPending(p)), this.menuItem(t, "mv-resume", "Resume", () => this.act(["resume", p.path], p.overlay))]
      : [this.menuItem(t, "mv-pending", "Pending…", () => this.openPending(p))];
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(section("Move to"))
      .children([...move, ...pendingItems])
      .child(div().my(4).h(1).bg(t.border))
      .when(Boolean(p.issue), (el) => el.child(this.menuItem(t, "mv-issue", `Open issue #${p.issue}`, () => {
        closeOverlay(p.overlay);
        this.openIssue({ repo: p.repo, issue: p.issue, path: p.path }, p.spaceId);
      })))
      .child(this.menuItem(t, "mv-rm", "Remove worktree…", () => this.removeWorktree(p), t.blocked));
  }

  // Herdr's own Remove worktree dialog, children first, one dialog each.
  // Never gated on CI.
  removeWorktree(p) {
    if (p.overlay) closeOverlay(p.overlay);
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

  openPending(p) {
    closeOverlay(p.overlay);
    openOverlay({ mod: "board-strip", kind: "dialog", width: 400, height: 300,
      props: { pendingDialog: true, path: p.path, title: p.title, reason: p.pending?.for ?? "", until: p.pending?.until ?? "" } });
  }

  // ---------- Pending dialog ----------

  initDialog(cx) {
    const p = props();
    this.reason = InputState.new({ value: p.reason ?? "" });
    this.until = InputState.new({ value: p.until || "+3d" });
    this.error = null;
    this.reason.on("submit", (_e, cx) => this.savePending(cx));
    this.until.on("submit", (_e, cx) => this.savePending(cx));
    this.reason.focus();
    cx.timer.after(400, () => this.reason.focus());
  }

  savePending(cx) {
    const p = props();
    const reason = this.reason.value().trim();
    const until = this.until.value().trim();
    if (!reason) { this.error = "Say what it is waiting on."; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const r = await exec(BIN(), ["pending", p.path, "--for", reason, "--until", until]);
      if (r.code === 0) return closeOverlay(p.overlay);
      this.error = (r.stderr || r.stdout).trim().replace(/^herdr-board: /, "");
      cx.notify();
    });
  }

  dialog(t) {
    const p = props();
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const quick = (id, text, value) => div().id(id).px(8).h(24).rounded(6).border_1().border_color(t.input).text_size(11.5)
      .text_color(t.muted).flex().items_center().cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.until.set_value(value); cx.notify(); }).child(text);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().size_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("Pending"))
      .child(div().pt(2).text_size(12).text_color(t.dim).truncate().child(p.title))
      .child(label("Waiting on"))
      .child(field(this.reason))
      .child(label("Check back"))
      .child(h_flex().gap(6).items_center()
        .child(div().w(140).child(field(this.until)))
        .child(quick("q-1d", "Tomorrow", "+1d")).child(quick("q-3d", "3 days", "+3d")).child(quick("q-1w", "1 week", "+1w")))
      .child(div().pt(6).text_size(11.5).text_color(this.error ? t.blocked : t.dim).child(this.error ?? "YYYY-MM-DD, or +3d / +1w"))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("pd-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("pd-save", "Save", true, (_e, cx) => this.savePending(cx))));
  }

  // ---------- opening things ----------

  open(c, lead) {
    if (lead) return run("pane.focus", { pane: lead.pane });
    run("space.new", { folder: c.path, name: `${repoName(c)} #${c.issue ?? ""}`.trim() });
  }

  // A click in tall mode opens the card and puts the strip back to its last short height.
  openCard(c, lead, tall) {
    if (tall) run("layout.resize", { id: "strip", px: this.lastShort ?? heightFor(2) });
    this.open(c, lead);
  }

  // A card's PR or issue opens in the card's own space, never the shown one.
  openInCard(c, spaceId, name, mod, modProps) {
    exec("test", ["-e", c.path ?? ""]).then(async (here) => {
      let id = spaceId && spaces().some((s) => s.id === spaceId) ? spaceId : spaces().find((s) => s.folder === c.path)?.id;
      if (!id && here.code === 0) {
        const r = await exec("herdr-app", ["do", "space.new", JSON.stringify({ folder: c.path, name: `${repoName(c)} #${c.issue ?? ""}`.trim() })]);
        try { id = JSON.parse(r.stdout).space; } catch { id = null; }
      }
      if (!id) return notify({ title: `Could not open ${name}`, body: `No space for ${c.path ?? "this card"}`, level: "error" });
      run("space.select", { id });
      const tab = spaces().find((s) => s.id === id)?.tabs.find((tab) => tab.name === name);
      if (tab) return run("tab.select", { id: tab.id });
      run("tab.new", { space: id, name, mod, props: modProps });
    });
  }

  openPr(c, spaceId, pr = c.pr) {
    if (!c.repo || !pr?.number) return;
    this.openInCard(c, spaceId, `PR #${pr.number}`, "pr", { repo: c.repo, number: pr.number });
  }

  openIssue(c, spaceId) {
    if (!c.repo || !c.issue) return;
    this.openInCard(c, spaceId, `#${c.issue}`, "issue-q", { repo: c.repo, issue: c.issue });
  }

  // ---------- pieces ----------

  // The agent status icon, compact.
  status(t, s) {
    if (s === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (s === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (s === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).border(1).border_color(t.dim);
  }

  chip(t, text, color) {
    return div().flex_none().px(4).h(14).rounded(4).bg(color + "26").text_size(10).font_medium().text_color(color).flex().items_center().child(text);
  }

  keyCap(t, text) {
    return div().flex_none().px(4).h(14).rounded(3).border_1().border_color(t.border).text_size(9.5).text_color(t.dim).flex().items_center().child(text);
  }

  // A PR the way GitHub draws it: green open, purple merged, red closed or blocked, gray draft.
  prBadge(t, pr, onClick) {
    const ci = pr.ci;
    let icon = "pr-open", color = PR_COLOR.open, why = "Open";
    if (pr.state === "MERGED") [icon, color, why] = ["pr-merged", PR_COLOR.merged, "Merged"];
    else if (pr.state === "CLOSED") [icon, color, why] = ["pr-closed", PR_COLOR.closed, "Closed without merging"];
    else if (pr.draft) [icon, color, why] = ["pr-draft", t.muted, "Draft"];
    if (pr.state === "OPEN") {
      if (pr.review_decision === "CHANGES_REQUESTED") [color, why] = [PR_COLOR.closed, `${why} · changes requested`];
      else if (ci?.state === "fail") [color, why] = [PR_COLOR.closed, `${why} · CI failing (${ci.failing} of ${ci.total})`];
      else if (ci?.state === "run") why += " · CI running";
      else if (ci?.state === "pass") why += " · CI passing";
      if (pr.review_decision === "APPROVED") why += " · approved";
    }
    return h_flex().id(`pr-${pr.number}-${pr.url ?? ""}`).flex_none().gap(2).items_center().px(2).h(14).rounded(4).tooltip(`PR #${pr.number}: ${why} · open`)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }))
      .child(svg(`${ICONS}/${icon}.svg`).size(11).flex_none().text_color(color))
      .child(div().text_size(10).font_medium().text_color(color).child(`#${pr.number}`));
  }

  // The board's right-hand detail: the date when Pending, the PR when there is one, else the age.
  detail(t, c, now, spaceId) {
    if (c.stage === "pending" && c.pending?.until) {
      if (!isDue(c)) return this.chip(t, shortDate(c.pending.until), t.muted);
      return this.chip(t, c.pending.until === localDay() ? "Due today" : `Overdue · ${shortDate(c.pending.until)}`, t.blocked);
    }
    const prs = prsOf(c);
    if (prs.length) return h_flex().flex_none().gap(2).items_center().children(prs.map((pr) => this.prBadge(t, pr, () => this.openPr(c, spaceId, pr))));
    const since = Date.parse(c.stage_changed ?? c.updated ?? "");
    return div().flex_none().text_size(10).text_color(t.dim).child(Number.isFinite(since) ? ago(now - since) : "");
  }

  // The strip's chip: tasks in progress, an unread spec or plan, CI after the merge; else detail().
  cardChip(t, c, kids, now, spaceId) {
    const d = this.docs.get(c.path);
    let unseen = null;
    if (c.stage === "planning" && d) {
      const fresh = [...unseenDocs(d.docs, shared("stage.seen") ?? {})];
      unseen = { spec: fresh.some((p) => p.includes("/specs/")), plan: fresh.some((p) => p.includes("/plans/")) };
    }
    const ci = c.stage === "done" ? ciAdvisory([c, ...kids].flatMap(prsOf)).state : null;
    const merged = c.stage === "done" ? [c, ...kids].flatMap(prsOf).some((p) => p.state === "MERGED") : false;
    const x = chipFor(c, { progress: d?.progress ?? null, unseen, ci, merged });
    if (!x) return this.detail(t, c, now, spaceId);
    return this.chip(t, x.text, { info: t.ansi4, warn: t.ansi3, bad: t.blocked, ok: t.ansi2 }[x.tone] ?? t.muted);
  }

  // A card's third line: one chip per tab in the space, its
  // program or mod icons and its own status dot; a click selects that tab. Chips that do not
  // fit in width px give way to "+k". key keeps ids unique when a space shows on two cards.
  tabRow(t, space, key, width) {
    const row = h_flex().h(18).mt(4).flex_none().min_w(0).gap(TAB_GAP).items_center().overflow_hidden();
    if (!space?.tabs?.length) return row;
    const ps = panes();
    const { shown, more } = fitChips(space.tabs.length, width);
    return row.children(space.tabs.slice(0, shown).map((tab) => {
      const kinds = tabKinds(tab.id, ps);
      const on = tab.active && space.active;
      const busy = tab.status && tab.status !== "idle";
      return h_flex().id(`tabchip-${key}-${tab.id}`).h(18).px(5).gap(3).flex_none().items_center().rounded(5)
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.raised : t.chrome)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .tooltip(`${tab.named ? tab.name : `Tab ${tab.name}`}: ${kinds.map((k) => k.label).join(" + ") || "empty"}`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); })
        .children(kinds.slice(0, 3).map((k) => (k.tint ? svg(k.icon).size(11).flex_none().text_color(on ? t.foreground : t.muted) : image(k.icon).size(11).flex_none())))
        .when(kinds.length > 3, (el) => el.child(div().text_size(9.5).text_color(t.dim).child(`+${kinds.length - 3}`)))
        .when(Boolean(busy), (el) => el.child(div().size(5).flex_none().rounded(3).bg(t[tab.status] ?? t.dim)));
    }))
      .when(more > 0, (el) => el.child(div().id(`tabmore-${key}-${space.id}`).flex_none().text_size(10).text_color(t.dim)
        .tooltip(space.tabs.slice(shown).map((tab) => (tab.named ? tab.name : `Tab ${tab.name}`)).join("\n"))
        .child(`+${more}`)));
  }

  // One card, CARD tall: status icon · title, then repo #issue · children badge · chip, then its tab row.
  cardBox(t, r, key, x, w) {
    const { c } = r;
    const inf = x.info.get(c.path) ?? {};
    const pending = c.stage === "pending";
    const dot = pending
      ? svg("mods/workspace-chrome/clock.svg").size(13).flex_none().text_color(isDue(c) ? t.blocked : t.muted)
      : this.status(t, inf.dot ?? null);
    const sel = c.path === x.selectedPath;
    const kids = x.kidsOf.get(c.path) ?? [];
    const hoverKey = `${key}:${c.path}`;
    const hovered = this.hovered === hoverKey;
    const sub = [`${repoName(c)}${c.issue ? ` #${c.issue}` : ""}`];
    if (pending && c.pending?.for) sub.push(c.pending.for);
    const repos = [...new Set(kids.map(repoName))];
    const advisory = c.stage === "done" ? ciAdvisory([c, ...kids].flatMap(prsOf)).text : null;
    return v_flex().id(`card-${key}-${c.path}`).h(CARD).flex_none().px(8).py(4).rounded(7).border_1()
      .border_color(sel ? t.accent : pending && isDue(c) ? t.blocked : t.border).bg(sel ? t.selected : t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = hoverKey;
        else if (this.hovered === hoverKey) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.openCard(c, inf.lead, x.tall))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(c, inf.spaceId); })
      .child(h_flex().h(16).min_w(0).gap(6).items_center()
        .child(h_flex().w(14).flex_none().justify_center().child(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(inf.dot || pending ? t.foreground : t.muted)
          .child(c.title || c.branch || c.path.split("/").pop()))
        .when(hovered && Boolean(c.issue), (el) => el.child(
          div().id(`issue-${key}-${c.path}`).flex_none().p(1).rounded(4).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip(`Open issue #${c.issue}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.openIssue(c, inf.spaceId); })
            .child(svg("mods/workspace-chrome/file-text.svg").size(12))))
        // Done: the worktree is reclaimable. Never gated on CI; a running CI only advises.
        .when(c.stage === "done", (el) => el.child(
          div().id(`rm-${key}-${c.path}`).flex_none().p(1).rounded(4).text_color(t.blocked).cursor_pointer()
            .hover((s) => s.bg(t.blocked + "26"))
            .tooltip(advisory ? `Remove worktree… ${advisory}` : "Remove worktree…")
            .on_click((_e, cx) => { cx.stop_propagation(); this.removeWorktree({ path: c.path, repo: c.repo, issue: c.issue, spaceId: inf.spaceId }); })
            .child(svg(`${ICONS}/trash-2.svg`).size(12)))))
      .child(h_flex().h(14).min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(sub.join(" · ")))
        .when(kids.length > 0, (el) => el.child(
          div().id(`kids-${key}-${c.path}`).flex_none().px(4).h(14).rounded(3).bg(t.border).text_size(10).text_color(t.muted).flex().items_center()
            .tooltip(kids.map((k) => `${repoName(k)} · ${k.branch ?? k.path.split("/").pop()}${prsOf(k).length ? ` · ${prsOf(k).map((p) => `PR #${p.number}`).join(", ")}` : ""}`).join("\n"))
            .child(`+${kids.length} ${repos.length === 1 ? repos[0] : "repos"}`)))
        .child(this.cardChip(t, c, kids, x.now, inf.spaceId)))
      .child(this.tabRow(t, spaces().find((sp) => sp.id === inf.spaceId) ?? spaces().find((sp) => inside(sp.folder, c.path)), `${key}-${c.path}`, rowWidth(w)));
  }

  // A teammate's PR under review: its title, repo #n · author, CI, and the review session's dot.
  reviewBox(t, r, key, w) {
    const { review, space, dot } = r;
    const pr = review.pr;
    const ciLook = { pass: ["CI passing", t.ansi2], fail: ["CI failing", t.blocked], run: ["CI running", t.ansi4] }[pr?.ci?.state];
    const who = pr?.author ? ` · ${pr.author}${pr.bot ? " (bot)" : ""}` : "";
    return v_flex().id(`review-${key}-${space.id}`).h(CARD).flex_none().px(8).py(4).rounded(7).border_1()
      .border_color(space.active ? t.accent : t.border).bg(space.active ? t.selected : t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => (r.lead ? run("pane.focus", { pane: r.lead.pane }) : run("space.select", { id: space.id })))
      .child(h_flex().h(16).min_w(0).gap(6).items_center()
        .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, dot)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(pr?.title ?? `${review.repo} #${review.number}`)))
      .child(h_flex().h(14).min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`${review.repo} #${review.number}${who}`))
        .when(Boolean(ciLook), (el) => el.child(this.chip(t, ciLook[0], ciLook[1]))))
      .child(this.tabRow(t, space, `${key}-${space.id}`, rowWidth(w)));
  }

  // An agent tied to no card or seat.
  otherBox(t, a, key) {
    return v_flex().id(`other-${key}-${a.address}`).h(CARD).flex_none().px(8).py(4).rounded(7).border_1()
      .border_color(a.focused ? t.accent : t.border).bg(a.focused ? t.selected : t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(h_flex().h(16).min_w(0).gap(6).items_center()
        .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, a.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(a.status === "idle" ? t.muted : t.foreground).child(agentLabel(a) ?? a.address)))
      .child(div().h(14).min_w(0).truncate().text_size(10.5).text_color(t.dim).child(a.space_name ?? ""));
  }

  // A Needs you row: one agent on one line, half a card tall, outlined in the color of the
  // section it belongs to (a seat in the left column is "general", drawn in the foreground color).
  // A click focuses it; the card it belongs to stays put.
  needBox(t, r, key) {
    const a = r.need;
    const outline = r.look === "general" ? t.foreground : t[STAGE_LOOK[r.look]?.color] ?? t.dim;
    return h_flex().id(`need-${key}-${a.address}`).h(NEED_ROW).flex_none().min_w(0).px(8).gap(6).items_center().rounded(7).border_1()
      .border_color(outline).bg(a.focused ? t.selected : t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${r.owner}\n${a.status === "blocked" ? "Waiting on you" : "Finished while you weren't looking"}`)
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, a.status)))
      .child(div().flex_shrink_0().max_w_1_2().truncate().text_size(12).text_color(t.foreground).child(agentLabel(a) ?? a.address))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(r.owner));
  }

  rowBox(t, r, key, x, w) {
    if (r.need) return this.needBox(t, r, key);
    if (r.review) return this.reviewBox(t, r, key, w);
    if (r.other) return this.otherBox(t, r.other, key);
    return this.cardBox(t, r, key, x, w);
  }

  colHeader(t, col, compact = false) {
    const look = STAGE_LOOK[col.id] ?? { icon: null, color: "dim" };
    const color = t[look.color] ?? t.dim;
    return h_flex().h(HEAD - 6).mb(6).flex_none().min_w(0).gap(5).items_center().text_size(10).font_medium()
      .when(Boolean(look.icon), (el) => el.child(svg(`${ICONS}/${look.icon}.svg`).size(11).flex_none().text_color(color)))
      .when(!compact, (el) => el.child(div().min_w(0).truncate().text_color(color).child(col.label.toUpperCase())))
      .child(div().flex_none().text_color(t.dim).child(String(col.rows.length)));
  }

  // A column too narrow to share the width: its header and count only; the tooltip lists it.
  countColumn(t, col) {
    const names = col.rows.map((r) => (r.need ? `${agentLabel(r.need) ?? r.need.address} · ${r.owner}` : r.review ? `${r.review.repo} #${r.review.number}` : r.other ? agentLabel(r.other) : r.c.title ?? r.c.path));
    return v_flex().id(`count-${col.id}`).w(COUNT_W).flex_none().h_full().min_h(0)
      .tooltip(`${col.label}\n${names.join("\n")}`)
      .child(this.colHeader(t, col, true))
      .child(div().text_size(10.5).text_color(t.dim).child(col.label));
  }

  column(t, col, w, x) {
    if (w === "count") return this.countColumn(t, col);
    return v_flex().w(w).flex_none().h_full().min_h(0)
      .child(this.colHeader(t, col))
      .child(v_flex().id(`col-${col.id}`).flex_1().min_h(0).gap(GAP).overflow_y_scrollbar()
        .when(!col.rows.length, (el) => el.child(div().pt(2).text_size(11).text_color(t.border).child("—")))
        .children(col.rows.map((r) => this.rowBox(t, r, col.id, x, w))));
  }

  // Tall mode: one row per repo, the stage columns lined up under one header that stays put.
  laneGrid(t, laneCols, widths, x) {
    const ls = lanes(laneCols);
    const cw = (id) => (widths[id] === "count" ? COUNT_W : widths[id]);
    return v_flex().flex_none().h_full().min_h(0)
      .child(h_flex().flex_none().gap(COL_GAP)
        .child(div().w(LANE_LABEL).flex_none().h(HEAD - 6).mb(6).flex().items_center().text_size(10).font_medium().text_color(t.dim).child("REPO"))
        .children(laneCols.map((col) => div().w(cw(col.id)).flex_none().child(this.colHeader(t, col, widths[col.id] === "count")))))
      .child(v_flex().id("lanes").flex_1().min_h(0).overflow_y_scrollbar().children(ls.map((lane, i) =>
        h_flex().id(`lane-${lane.repo}`).flex_none().gap(COL_GAP).items_start().py(4).when(i > 0, (el) => el.border_t(1).border_color(t.border))
          .child(div().w(LANE_LABEL).flex_none().pt(2).truncate().text_size(11.5).text_color(t.muted).child(lane.repo))
          .children(laneCols.map((col) => {
            const rows = sortRows(lane.cells[col.id] ?? [], x.selectedPath, x.now);
            if (widths[col.id] === "count") return div().w(COUNT_W).flex_none().pt(2).text_size(10.5).text_color(t.dim).child(rows.length ? String(rows.length) : "");
            return v_flex().w(cw(col.id)).flex_none().gap(GAP).children(rows.map((r) => this.rowBox(t, r, `lane-${lane.repo}-${col.id}`, x, cw(col.id))));
          })))));
  }

  // The fixed left column: Projects and the GitHub check, then the seats from seats.json. Seats
  // with a one-click command are buttons, two to a row; the rest are cards like a board card's.
  leftColumn(t, seatRows, now) {
    const syncedAt = Date.parse(this.synced ?? "");
    const syncText = this.syncing
      ? "Checking GitHub…"
      : this.errors.length
        ? `GitHub check: ${this.errors.length} error${this.errors.length > 1 ? "s" : ""}`
        : Number.isFinite(syncedAt) ? `GitHub checked ${ago(now - syncedAt)} ago` : "GitHub not checked yet";
    const projectsKey = keyHint("board-strip.projects");

    const seatButton = (r) => {
      const id = seatTerminal(r.s);
      return v_flex().id(`seat-${id}`).flex_1().min_w(0).h(CARD).px(8).justify_center().rounded(7).border_1()
        .border_color(r.focused ? t.accent : t.input).bg(r.focused ? t.selected : t.chrome)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`${r.s.command.label ?? r.s.command.send ?? r.s.command.run}\nRight-click: go to ${r.s.name}`)
        .on_click(() => this.runSeatCommand(r.s))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openSeat(r.s, r.lead); })
        .child(h_flex().h(16).min_w(0).gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(r.s.name))
          .when(Boolean(r.top), (el) => el.child(this.status(t, r.top.status))))
        .child(div().h(12).text_size(9.5).text_color(t.dim).child(keyHint(r.s.command.action) || " "));
    };

    const seatCard = (r) => {
      const { s } = r;
      const id = seatTerminal(s);
      const n = r.agents.length;
      const where = s.folder === home() ? "~" : s.folder.split("/").pop();
      const sub = `${where}${n ? ` · ${n} session${n > 1 ? "s" : ""}` : r.tabs ? ` · ${r.tabs} tab${r.tabs > 1 ? "s" : ""}` : " · not open"}`;
      const hint = keyHint(s.action);
      return v_flex().id(`seat-${id}`).h(CARD).flex_none().px(8).py(4).rounded(7).border_1()
        .border_color(r.focused ? t.accent : t.border).bg(r.focused ? t.selected : t.raised)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click(() => this.openSeat(s, r.lead))
        .child(h_flex().h(16).min_w(0).gap(6).items_center()
          .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, r.top?.status ?? null)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(s.name))
          .when(Boolean(hint), (el) => el.child(this.keyCap(t, hint))))
        .child(div().h(14).min_w(0).truncate().text_size(10.5).text_color(t.dim).child(sub))
        .child(this.tabRow(t, spaces().find((sp) => sp.name === s.space), id, rowWidth(LEFT_COL)));
    };

    const buttons = seatRows.filter((r) => r.s.command);
    const pairs = [];
    for (let i = 0; i < buttons.length; i += 2) pairs.push(buttons.slice(i, i + 2));

    return v_flex().id("left").w(LEFT_COL).flex_none().h_full().min_h(0).gap(GAP).overflow_y_scrollbar()
      .child(h_flex().h(HEAD - 6).mb(6 - GAP).flex_none().min_w(0).gap(6).items_center().justify_between().text_size(10.5)
        .child(h_flex().id("strip-projects").flex_none().gap(4).items_center().text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).tooltip("Toggle the Projects panel")
          .on_click(() => this.toggleProjects())
          .child(div().child("▤ Projects"))
          .when(Boolean(projectsKey), (el) => el.child(this.keyCap(t, projectsKey))))
        .child(div().id("strip-sync").min_w(0).truncate().text_color(this.errors.length ? t.blocked : t.dim)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip(this.errors.map((e) => e.error).join("\n") || "Check GitHub now")
          .on_click((_e, cx) => this.sync(cx))
          .child(`↻ ${syncText}`)))
      .children(pairs.map((pair) => h_flex().h(CARD).flex_none().gap(6).children(pair.map(seatButton))))
      .children(seatRows.filter((r) => !r.s.command).map(seatCard));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menu(t);
    if (props()?.pendingDialog) return this.dialog(t);
    const now = Date.now();
    const width = this.size?.width ?? 1200;
    const tall = isTall(this.size?.height ?? heightFor(2));
    const allPanes = panes();
    const cwdOf = new Map(allPanes.map((p) => [p.pane, p.cwd]));
    const list = agents();
    const spaceOfTab = (tabId) => (tabId ? spaces().find((s) => s.tabs.some((tab) => tab.id === tabId))?.id ?? null : null);

    // Root cards still on the board; a child card is a badge on its parent.
    const kidsOf = childrenOf(this.cards);
    const roots = Object.values(this.cards)
      .filter((c) => !(c.parent && this.cards[c.parent]))
      .filter((c) => !(c.stage === "done" && now - Date.parse(c.stage_changed ?? 0) > DONE_KEEP_MS));
    this.toastDue(roots);

    // Each card's agents: terminals inside its worktree or a child's, plus any in its space.
    // The dot is the most urgent of them; the lead is what a click focuses.
    const claimed = new Set();
    const info = new Map();
    // What each agent belongs to, for its Needs you row: {card?, text}.
    const ownerOf = new Map();
    for (const c of roots) {
      const folders = [c.path, ...(kidsOf.get(c.path) ?? []).map((k) => k.path)];
      const inFolders = list.filter((a) => folders.some((f) => inside(cwdOf.get(a.pane), f)));
      const top = mostUrgent(inFolders);
      const pane = top ? null : allPanes.find((p) => inside(p.cwd, c.path));
      const lead = top ?? pane;
      const spaceId = spaceOfTab(lead?.tab) ?? spaces().find((s) => inside(s.folder, c.path))?.id ?? null;
      const mine = [...inFolders, ...list.filter((a) => spaceId && a.space === spaceId && !inFolders.includes(a))];
      mine.forEach((a) => claimed.add(a.address));
      mine.forEach((a) => ownerOf.set(a.address, { card: c, look: c.stage, text: `${repoName(c)}${c.issue ? ` #${c.issue}` : ""} · ${c.title || c.branch || c.path.split("/").pop()}` }));
      info.set(c.path, { agent: top, dot: cardDot(mine.map((a) => a.status)), lead, spaceId, focused: mine.some((a) => a.focused) });
    }
    // Seats claim their agents next: a seat with a space owns that space's agents, one
    // without owns agents whose folder is inside its own.
    const seatRows = this.seats.map((s) => {
      const seatSpace = s.space ? spaces().find((sp) => sp.name === s.space) : null;
      const ours = (a) => (s.space ? Boolean(seatSpace) && a.space === seatSpace.id : inside(cwdOf.get(a.pane), s.folder));
      const mine = list.filter((a) => !claimed.has(a.address) && ours(a));
      mine.forEach((a) => { claimed.add(a.address); ownerOf.set(a.address, { text: s.name, look: "general" }); });
      const top = mostUrgent(mine);
      const spaceTabs = new Set(seatSpace?.tabs.map((tab) => tab.id) ?? []);
      const pane = top ? null : allPanes.find((p) => (s.space ? spaceTabs.has(p.tab) : inside(p.cwd, s.folder)));
      const lead = top ?? pane;
      return { s, agents: mine, top, lead, spaceId: spaceOfTab(lead?.tab), focused: mine.some((a) => a.focused), tabs: seatSpace?.tabs.length ?? 0 };
    });
    // Team reviews: open herdr-review spaces, joined to reviews.json for title, author and CI.
    // A space with no row there still shows, as repo #n.
    const teamReviews = [];
    for (const sp of spaces()) {
      const m = /^Review (\S+) #(\d+)$/.exec(sp.name ?? "");
      if (!m) continue;
      const pr = this.reviews.find((p) => p.repo?.split("/").pop() === m[1] && p.number === Number(m[2])) ?? null;
      const mine = list.filter((a) => a.space === sp.id && !claimed.has(a.address));
      mine.forEach((a) => { claimed.add(a.address); ownerOf.set(a.address, { look: "team", text: `Review ${m[1]} #${m[2]}${pr?.title ? ` · ${pr.title}` : ""}` }); });
      teamReviews.push({ review: { repo: m[1], number: Number(m[2]), pr }, space: sp, dot: cardDot(mine.map((a) => a.status)), lead: mostUrgent(mine), agents: mine });
    }
    const others = list.filter((a) => !claimed.has(a.address)).map((a) => ({ other: a }));
    // Needs you lists agents, not cards: blocked first, then finished-unseen. A card keeps its stage
    // column, so focusing an agent clears its row here and nothing else on the board moves.
    const needs = list
      .filter((a) => agentNeedsYou(a, ownerOf.get(a.address)?.card ?? null))
      .map((a, i) => ({ a, i }))
      .sort((p, q) => (RANK[q.a.status] ?? 0) - (RANK[p.a.status] ?? 0) || p.i - q.i)
      .map(({ a }) => ({ need: a, owner: ownerOf.get(a.address)?.text ?? a.space_name ?? "", look: ownerOf.get(a.address)?.look ?? "others" }));

    const active = spaces().find((s) => s.active);
    const selectedPath = roots.find((c) => (active && info.get(c.path)?.spaceId === active.id) || inside(active?.folder, c.path))?.path ?? null;
    const columns = columnsFor({ cards: roots, agentOf: (c) => info.get(c.path)?.agent ?? null, needs, teamReviews, others, now })
      .map((col) => (col.id === "needs" || col.id === "team" || col.id === "others" ? col : { ...col, rows: sortRows(col.rows, selectedPath, now) }));
    setAgentOrder([...new Set([
      ...seatRows.flatMap((r) => r.agents.map((a) => a.address)),
      ...columns.flatMap((col) => col.rows.flatMap((r) => (r.need ? [r.need.address] : r.other ? [r.other.address] : r.agents ? r.agents.map((a) => a.address) : r.agent ? [r.agent.address] : []))),
    ])]);

    const x = { info, kidsOf, selectedPath, now, tall };
    const ids = columns.map((c) => c.id);
    // The left column, the side padding and one gap per column come off the top; the rest is shared.
    let body;
    if (!roots.length && this.readError) {
      body = div().flex_1().pt(20).text_size(12).text_color(t.dim).child(this.readError);
    } else if (tall) {
      const laneCols = columns.filter((c) => c.id !== "needs" && c.id !== "team" && c.id !== "others");
      const needsCol = columns.find((c) => c.id === "needs");
      const sideCols = columns.filter((c) => c.id === "team" || c.id === "others");
      const widths = columnWidths(width - 2 * STRIP_PX - COL_GAP * (ids.length + 1) - LANE_LABEL, ids);
      body = h_flex().flex_1().min_w(0).h_full().min_h(0).gap(COL_GAP).overflow_hidden()
        .child(this.column(t, needsCol, widths.needs, x))
        .when(laneCols.length > 0, (el) => el.child(this.laneGrid(t, laneCols, widths, x)))
        .children(sideCols.map((col) => this.column(t, col, widths[col.id], x)));
    } else {
      const widths = columnWidths(width - 2 * STRIP_PX - COL_GAP * ids.length, ids);
      body = h_flex().flex_1().min_w(0).h_full().min_h(0).gap(COL_GAP).overflow_hidden()
        .children(columns.map((col) => this.column(t, col, widths[col.id], x)));
    }

    return h_flex().id("root").size_full().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => this.onSize(size, cx))
      .bg(t.chrome).border_t(1).border_color(t.border)
      .px(STRIP_PX).pt(5).pb(8).gap(COL_GAP).items_start().text_size(12)
      .child(this.leftColumn(t, seatRows, now))
      .child(body);
  }
}
