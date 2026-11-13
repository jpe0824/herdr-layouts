// A GitHub pull request as a center tab: Conversation, Files changed, Checks, and a
// review box (Comment / Approve / Request changes) that posts as you through `gh`,
// after a confirm click. Props: { repo: "owner/name", number }, and optionally
// { view: "files", trace: true, file, line } to open Files changed with Trace on at a line.
// Opened by the Reviews panel and the board's PR badges with
//   tab.new { space, name: "PR #<n>", mod: "pr", props: { repo, number } }

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { props, theme, exec, settings, home, shared, setShared, openOverlay, closeOverlay, focused } from "herdr";

const FIELDS = "number,title,state,isDraft,mergedAt,author,createdAt,updatedAt,body,labels,comments,reviews,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,files,headRefName,baseRefName,url,commits,mergeStateStatus";
const REFRESH_MS = 2 * 60 * 1000;
const GH = { open: "#3fb950", merged: "#a371f7", closed: "#f85149", draft: "#8b949e", pending: "#d29922" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FAIL = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 7 * 1440) return `${Math.floor(mins / 1440)}d ago`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
function ink(hex) {
  const n = parseInt(hex, 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? "#1f2328" : "#ffffff";
}
function checkState(c) {
  const word = (c.conclusion || c.state || "").toUpperCase();
  if (FAIL.has(word)) return "fail";
  if (word === "SUCCESS" || word === "NEUTRAL" || word === "SKIPPED") return "pass";
  return "run";
}
// GitHub lists every run of a check; a re-run (after adding a label, say) sits beside
// the old failures. Keep only the latest run of each check.
function latestChecks(list) {
  const at = (c) => Date.parse(c.startedAt || c.completedAt || c.createdAt || "") || 0;
  const best = new Map();
  for (const c of list ?? []) {
    const key = `${c.workflowName ?? ""}/${c.name || c.context || ""}`;
    if (!best.has(key) || at(c) >= at(best.get(key))) best.set(key, c);
  }
  return [...best.values()];
}

// A unified diff split per file, each with its lines numbered once.
function splitDiff(text) {
  const files = [];
  let cur = null, old = 0, next = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: line.replace(/^diff --git a\/.* b\//, ""), rows: [] };
      files.push(cur);
      continue;
    }
    if (!cur || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; cur.rows.push({ kind: "@", text: line }); continue; }
    const k = line[0];
    if (k === "-") cur.rows.push({ kind: "-", old: old++, text: line.slice(1) || " " });
    else if (k === "+") cur.rows.push({ kind: "+", next: next++, text: line.slice(1) || " " });
    else if (k === " ") cur.rows.push({ kind: " ", old: old++, next: next++, text: line.slice(1) || " " });
    else if (line.startsWith("\\")) cur.rows.push({ kind: "@", text: line });
  }
  return files;
}

// herdr-blame: which Claude Code turn wrote each added line, read from the transcripts.
const BLAME = () => `${home()}/.claude/herdr/bin/herdr-blame`;
// One colour per turn, cycled by turn order. Kept off pure green/red so a gutter mark never
// reads as an added/removed marker.
const TURN_COLORS = ["#58a6ff", "#d29922", "#bc8cff", "#39c5cf", "#f778ba", "#e3b341", "#79c0ff", "#ffa657"];
const turnColor = (n) => TURN_COLORS[(n - 1) % TURN_COLORS.length];
function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// The first `n` lines of a text, and whether any were cut.
function head(text, n) {
  const lines = (text ?? "").split("\n");
  return { text: lines.slice(0, n).join("\n"), cut: lines.length > n };
}

const METHOD_NAMES = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };
const METHOD_HELP = {
  squash: "Combine every commit into one on the base branch.",
  merge: "Keep every commit, joined by a merge commit.",
  rebase: "Replay every commit onto the base branch, no merge commit.",
};

export default class Pr extends View {
  init(_props, cx) {
    // Popup copies: the merge-method dropdown and the label picker.
    if (props()?.menu === "labels") return this.initLabels(cx);
    if (props()?.menu) return;
    this.data = null;
    this.error = null;
    this.view = "conversation";
    this.diff = null;
    this.file = null;
    this.me = null;
    this.box = TextareaState.new({ placeholder: "Leave a comment (markdown)", rows: 4 });
    this.pending = null; // { kind, label } awaiting confirm
    this.posting = false;
    this.note = null;
    this.methods = [];
    this.deleteBranch = true;
    // Trace: { files, turns } from herdr-blame once asked for; sel is the clicked line.
    this.blame = null;
    this.traceOn = false;
    this.tracing = false;
    this.traceError = null;
    this.sel = null; // { turn, path, line, owners }
    this.focusTurn = null;
    this.open = new Set(); // expanded sections in the turn panel
    this.fetch(cx);
    const start = props() ?? {};
    if (start.file) this.file = start.file;
    if (start.view === "files") this.show("files", cx);
    if (start.trace) this.trace(cx);
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["repo", "view", props().repo, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
      try {
        const m = JSON.parse(r.stdout);
        // Merge commit first: it is the default whenever the repo allows it.
        this.methods = [m.mergeCommitAllowed && "merge", m.squashMergeAllowed && "squash", m.rebaseMergeAllowed && "rebase"].filter(Boolean);
      } catch { this.methods = ["merge"]; }
      cx.notify();
    });
    this.refreshSeen = shared("pr.refresh") ?? 0;
    cx.spawn(async () => {
      const r = await exec("gh", ["api", "user", "--jq", ".login"]);
      this.me = r.stdout.trim() || null;
    });
    cx.timer.every(REFRESH_MS, (cx) => { this.load(cx); });
    // While checks run (say, after adding a label), look again every 20 seconds.
    cx.timer.every(20000, (cx) => { if (this.runningChecks() > 0) this.load(cx); });
    cx.timer.every(60000, (cx) => cx.notify());
  }

  runningChecks() {
    return (this.data?.statusCheckRollup ?? []).filter((c) => checkState(c) === "run").length;
  }

  // The chosen merge method, remembered per repo (the dropdown writes it).
  get method() {
    const chosen = shared(`pr.method.${props()?.repo}`);
    return this.methods.includes(chosen) ? chosen : (this.methods[0] ?? "merge");
  }

  // ---------- popups ----------

  // A popup menu. Given the press that opened it, it sits against that control: above
  // it (the merge bar is at the bottom of the page), else below.
  // Opened from on_click, with the press saved by on_mouse_down for its position: opened on
  // the press itself, the release that follows lands beside the new popup and closes it.
  openMenu(kind, cx, extra = {}, press = null, above = false) {
    const p = props();
    const width = kind === "method" ? 320 : 300;
    const height = kind === "method" ? 34 + this.methods.length * 50 + 12 : 360;
    const b = press?.bounds;
    const at = b ? { x: Math.max(8, b.x + b.width - width), y: above ? Math.max(8, b.y - height - 6) : b.y + b.height + 6 } : undefined;
    openOverlay({ mod: "pr", kind: "popup", width, height, ...(at ? { at } : {}),
      props: { menu: kind, repo: p.repo, number: p.number, methods: this.methods, ...extra } });
  }

  methodMenu(t) {
    const p = props();
    const cur = shared(`pr.method.${p.repo}`) ?? p.methods[0];
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Merge method"))
      .children(p.methods.map((m) => h_flex().id(`mm-${m}`).px(8).py(6).gap(9).rounded(7).items_start().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => { setShared(`pr.method.${p.repo}`, m); closeOverlay(p.overlay); })
        .child(div().w(14).pt(1).flex_none().text_color(t.foreground).child(m === cur ? "✓" : ""))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_color(t.foreground).child(METHOD_NAMES[m]))
          .child(div().text_size(11.5).text_color(t.dim).child(METHOD_HELP[m])))));
  }

  initLabels(cx) {
    this.labels = null;
    this.on = new Set(props().current ?? []);
    this.busy = null;
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["label", "list", "--repo", props().repo, "--limit", "200", "--json", "name,color,description"]);
      try {
        // semver labels first: the required check wants exactly one of them.
        this.labels = JSON.parse(r.stdout).sort((a, b) => Number(b.name.startsWith("semver:")) - Number(a.name.startsWith("semver:")) || a.name.localeCompare(b.name));
      } catch { this.labels = []; this.error = (r.stderr || "gh label list failed").trim(); }
      cx.notify();
    });
  }

  toggleLabel(name, cx) {
    const p = props();
    const add = !this.on.has(name);
    this.busy = name;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "edit", String(p.number), "--repo", p.repo, add ? "--add-label" : "--remove-label", name]);
      this.busy = null;
      if (r.code === 0) { add ? this.on.add(name) : this.on.delete(name); setShared("pr.refresh", Date.now()); this.error = null; }
      else this.error = (r.stderr || r.stdout).trim();
      cx.notify();
    });
  }

  labelMenu(t) {
    const semverSet = [...this.on].filter((n) => /^semver:(patch|minor|major)$/.test(n)).length;
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(semverSet === 1 ? t.dim : t.blocked)
        .child(semverSet === 1 ? "Labels" : semverSet ? "Labels · pick only one semver label" : "Labels · this repo requires one semver label"))
      .child(v_flex().id("lbl-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!this.labels, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("Loading…")))
        .children((this.labels ?? []).map((l) => h_flex().id(`lbl-${l.name}`).px(8).py(5).gap(9).rounded(7).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip(l.description || l.name)
          .on_click((_e, cx) => { if (!this.busy) this.toggleLabel(l.name, cx); })
          .child(div().w(14).flex_none().text_color(t.foreground).child(this.busy === l.name ? "…" : this.on.has(l.name) ? "✓" : ""))
          .child(div().size(10).flex_none().rounded(5).bg(`#${l.color}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(l.name)))))
      .when(Boolean(this.error), (el) => el.child(div().px(8).py(4).text_size(11.5).text_color(t.blocked).child(this.error)));
  }

  fetch(cx) { cx.spawn(async (cx) => this.load(cx)); }

  async load(cx) {
    this.cx = cx;
    const { repo, number } = props() ?? {};
    if (!repo || !number) { this.error = "This tab needs a repo and a PR number."; cx.notify(); return; }
    this.loading = true;
    cx.notify();
    try {
      const r = await exec("gh", ["pr", "view", String(number), "--repo", repo, "--json", FIELDS], { timeout: 60000 });
      if (r.code === 0) {
        this.data = JSON.parse(r.stdout);
        this.data.statusCheckRollup = latestChecks(this.data.statusCheckRollup);
        this.error = null;
        this.fetchedAt = Date.now();
      }
      else this.error = (r.stderr || "gh pr view failed").trim();
    } catch (e) { this.error = String(e); }
    if (this.diff !== null) await this.loadDiff();
    this.loading = false;
    cx.notify();
  }

  async loadDiff() {
    const { repo, number } = props();
    try {
      const r = await exec("gh", ["pr", "diff", String(number), "--repo", repo], { timeout: 120000 });
      this.diff = r.code === 0 ? splitDiff(r.stdout) : [];
      this.diffError = r.code === 0 ? null : (r.stderr || "gh pr diff failed").trim();
    } catch (e) { this.diff = []; this.diffError = String(e); }
    if (!this.file || !this.diff.some((f) => f.path === this.file)) this.file = this.diff[0]?.path ?? null;
  }

  show(view, cx) {
    this.view = view;
    if (view === "files" && this.diff === null) cx.spawn(async (cx) => { this.diff = []; this.diffLoading = true; cx.notify(); await this.loadDiff(); this.diffLoading = false; cx.notify(); });
    cx.notify();
  }

  // Trace on/off. The first time it runs herdr-blame, which reads the branch's Claude
  // transcripts (a few seconds) and caches the result per PR head.
  trace(cx) {
    if (this.tracing) return;
    if (this.blame) { this.traceOn = !this.traceOn; if (!this.traceOn) { this.sel = null; this.focusTurn = null; } cx.notify(); return; }
    const { repo, number } = props();
    this.tracing = true;
    this.traceError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(BLAME(), [repo, String(number), "--json"], { timeout: 180000 });
        if (r.code === 0) {
          this.blame = JSON.parse(r.stdout);
          this.traceOn = true;
          const { file, line } = props();
          const own = file && line ? this.blame.files?.[file]?.[String(line)] : null;
          if (own) { this.file = file; this.sel = { turn: own[0], path: file, line: Number(line), owners: own }; }
        }
        else this.traceError = (r.stderr || "herdr-blame failed").trim().replace(/^herdr-blame: /, "");
      } catch (e) { this.traceError = String(e); }
      this.tracing = false;
      cx.notify();
    });
  }

  owners(path, r) {
    return this.traceOn && r.kind === "+" ? this.blame?.files?.[path]?.[String(r.next)] ?? null : null;
  }

  pick(turn, cx, sel = null) {
    this.sel = sel ?? { turn, path: null, line: null, owners: [turn] };
    if (this.focusTurn) this.focusTurn = turn;
    cx.notify();
  }

  // A section of the turn panel: a small label over a body.
  section(t, label, body) {
    return v_flex().gap(5).child(div().text_size(11).font_medium().text_color(t.dim).child(label)).child(body);
  }

  // Text cut to `n` lines, with a Show more / Show less link when it was cut.
  clipped(t, key, text, n, markdown = false) {
    const full = this.open.has(key), h = head(text, n);
    const shown = full ? text : h.text;
    return v_flex().gap(4)
      .child(markdown
        ? div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`blame-${key}-${full ? 1 : 0}`, shown).selectable(true))
        : div().text_size(12.5).text_color(t.foreground).whitespace_normal().child(shown))
      .when(h.cut, (el) => el.child(div().id(`blame-more-${key}`).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { full ? this.open.delete(key) : this.open.add(key); cx.notify(); })
        .child(full ? "Show less" : "Show more")));
  }

  turnChip(t, turn, cx) {
    return h_flex().id(`blame-chip-${turn.id}`).px(7).h(22).gap(5).items_center().rounded(11).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(turn.id, cx))
      .child(div().size(8).rounded(4).bg(turnColor(turn.n)))
      .child(div().text_size(11.5).text_color(t.foreground).child(`Turn ${turn.n}`))
      .child(div().text_size(11).text_color(t.dim).child(stamp(turn.start)));
  }

  blamePanel(t) {
    const b = this.blame, sel = this.sel, turn = b?.turns?.[sel?.turn];
    if (!turn) return null;
    const root = turn.root && turn.root !== turn.id ? b.turns[turn.root] : null;
    const others = (sel.owners ?? []).filter((id) => id !== turn.id).map((id) => b.turns[id]).filter(Boolean);
    const last = turn.messages?.[turn.messages.length - 1];
    const focused = this.focusTurn === turn.id;
    return v_flex().w(380).flex_none().h_full().border_l(1).border_color(t.border).bg(t.background)
      .child(h_flex().px(14).h(32).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().size(10).rounded(5).bg(turnColor(turn.n)))
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(`Turn ${turn.n}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .child(`${stamp(turn.start)} · ${turn.files.length} file${turn.files.length === 1 ? "" : "s"} · ${turn.session.slice(0, 8)}`))
        .child(div().id("blame-close").px(6).text_size(14).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.sel = null; this.focusTurn = null; cx.notify(); }).child("✕")))
      .child(v_flex().id("blame-panel").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).gap(14)
        .child(h_flex().gap(6).flex_wrap()
          .child(this.button(t, "blame-focus", focused ? "Show all turns" : "Highlight this turn", (_e, cx) => { this.focusTurn = focused ? null : turn.id; cx.notify(); }))
          .when(sel.line !== null, (el) => el.child(div().text_size(11.5).text_color(t.dim).pt(6).child(`line ${sel.line}`))))
        .when(Boolean(turn.prompt), (el) => el.child(this.section(t, "Your prompt", this.clipped(t, `p-${turn.id}`, turn.prompt, 12))))
        .when(Boolean(root), (el) => el.child(this.section(t, "Follows your prompt",
          v_flex().gap(6).child(h_flex().child(this.turnChip(t, root))).child(this.clipped(t, `rp-${turn.id}`, root.prompt ?? "", 8)))))
        .when(Boolean(turn.trigger), (el) => el.child(this.section(t, `Started by a ${turn.trigger}`,
          this.clipped(t, `tr-${turn.id}`, turn.trigger_text ?? "", 10, true))))
        .when((turn.questions ?? []).length > 0, (el) => el.child(this.section(t, "Questions asked",
          v_flex().gap(8).children(turn.questions.map((q) => v_flex().gap(3)
            .child(div().text_size(12.5).text_color(t.foreground).whitespace_normal().child(q.questions.join("\n")))
            .child(div().text_size(12.5).text_color(t.accent).whitespace_normal().child(q.answer.trim())))))))
        .when(Boolean(turn.plan), (el) => el.child(this.section(t, "Plan", this.clipped(t, `plan-${turn.id}`, turn.plan, 6, true))))
        .when((turn.subagents ?? []).length > 0, (el) => el.child(this.section(t, "Subagents in this turn",
          v_flex().gap(2).children(turn.subagents.map((a) => div().text_size(12.5).text_color(t.foreground).child(`· ${a}`))))))
        .when(Boolean(last), (el) => el.child(this.section(t, "What the agent said", this.clipped(t, `m-${turn.id}`, last, 16, true))))
        .when(others.length > 0, (el) => el.child(this.section(t, "This line was also added by",
          h_flex().gap(6).flex_wrap().children(others.map((o) => this.turnChip(t, o))))))
        .child(this.section(t, "Files in this turn", v_flex().gap(1).children(turn.files.map((f) =>
          div().id(`blame-file-${f}`).px(6).h(22).flex().items_center().rounded(5).truncate().text_size(12).cursor_pointer()
            .text_color(f === this.file ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).tooltip(f)
            .on_click((_e, cx) => { this.file = f; cx.notify(); }).child(f))))));
  }

  // herdr-review: the PR checked out in its own worktree, in a space with this PR and a
  // Claude session running the code-review skill. An open one is selected instead.
  startReview(cx) {
    if (this.reviewing) return;
    const { repo, number } = props();
    this.reviewing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(`${home()}/.claude/herdr/bin/herdr-review`, [repo, String(number)], { timeout: 300000 });
      this.reviewing = false;
      if (r.code !== 0) this.note = (r.stderr || r.stdout).trim().replace(/^herdr-review: /, "");
      cx.notify();
    });
  }

  // ---------- posting ----------

  ask(kind, cx) {
    const body = this.box.value().trim();
    if (kind !== "merge" && (kind === "comment" || kind === "changes") && !body) { this.note = kind === "comment" ? "Write a comment first." : "Say what needs to change."; cx.notify(); return; }
    const label = {
      comment: "Post this comment", approve: "Approve this PR", changes: "Request changes",
      merge: `${METHOD_NAMES[this.method]}${this.mergeMode(this.data).mode === "bypass" ? ` with admin bypass (${this.mergeMode(this.data).why})` : ""}${this.deleteBranch ? ", delete the branch," : ""}`,
    }[kind];
    this.pending = { kind, label };
    this.note = null;
    cx.notify();
  }

  post(cx) {
    const { repo, number } = props();
    const { kind } = this.pending;
    const body = this.box.value().trim();
    // Merge: --admin only when GitHub would block the merge (mergeMode "bypass").
    const bypass = kind === "merge" && this.mergeMode(this.data).mode === "bypass";
    const args = kind === "merge"
      ? ["pr", "merge", String(number), "--repo", repo, `--${this.method}`, ...(bypass ? ["--admin"] : []), ...(this.deleteBranch ? ["--delete-branch"] : [])]
      : kind === "comment"
      ? ["pr", "comment", String(number), "--repo", repo, "--body", body]
      : ["pr", "review", String(number), "--repo", repo, kind === "approve" ? "--approve" : "--request-changes", ...(body ? ["--body", body] : [])];
    this.posting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("gh", args, { timeout: 60000 });
      this.posting = false;
      this.pending = null;
      if (r.code === 0) {
        if (kind !== "merge") this.box.set_value("");
        this.note = { comment: "Comment posted.", approve: "Approved.", changes: "Changes requested.", merge: "Merged." }[kind];
        await this.load(cx);
        // The Reviews panel and board read these; refresh now rather than on the next poll.
        if (kind !== "comment") exec(`${home()}/.claude/herdr/bin/herdr-board`, kind === "merge" ? ["sync"] : ["reviews"], { timeout: 180000 })
          .then(() => kind === "merge" && exec(`${home()}/.claude/herdr/bin/herdr-board`, ["reviews"], { timeout: 180000 })).catch(() => {});
      } else this.note = (r.stderr || r.stdout || "gh failed").trim();
      cx.notify();
    });
  }

  // ---------- pieces ----------

  button(t, id, label, onClick, style = "plain") {
    const solid = { green: "#238636", purple: "#8250df", amber: "#9a6700" }[style];
    const bg = solid ?? (style === "red" ? t.blocked + "22" : t.raised);
    const fg = solid ? "#ffffff" : style === "red" ? t.blocked : t.foreground;
    return div().id(id).flex_none().px(10).h(28).rounded(6).border_1().border_color(solid ?? t.border).bg(bg)
      .text_size(12).font_medium().text_color(fg).flex().items_center().cursor_pointer()
      .hover((s) => s.opacity(0.88)).when(Boolean(onClick), (el) => el.on_click(onClick)).child(label);
  }

  pill(t, d) {
    const [color, word, icon] = d.mergedAt ? [GH.merged, "Merged", "pr-merged"] : d.state === "CLOSED" ? [GH.closed, "Closed", "pr-closed"]
      : d.isDraft ? [GH.draft, "Draft", "pr-draft"] : [GH.open, "Open", "pr-open"];
    return h_flex().flex_none().px(10).h(26).rounded(13).bg(color).gap(5).items_center().text_size(12).font_semibold().text_color("#ffffff")
      .child(svg(`mods/board-strip/icons/${icon}.svg`).size(13).text_color("#ffffff")).child(word);
  }

  entry(t, id, who, at, verb, body, accent) {
    return v_flex().w_full().rounded(8).border_1().border_color(accent ? accent + "88" : t.border).overflow_hidden()
      .child(h_flex().px(12).h(34).gap(6).items_center().bg(accent ? accent + "1a" : t.surface).border_b(1).border_color(t.border).text_size(12.5)
        .child(div().font_semibold().text_color(t.foreground).child(who))
        .child(div().text_color(accent ?? t.muted).child(`${verb} ${when(at)}`)))
      .when(Boolean(body?.trim()), (el) => el.child(div().px(14).py(10).text_size(13.5).text_color(t.foreground).child(TextView.markdown(id, body).selectable(true))));
  }

  conversation(t, d) {
    const reviewVerb = { APPROVED: ["approved these changes", GH.open], CHANGES_REQUESTED: ["requested changes", GH.closed], COMMENTED: ["reviewed", null], DISMISSED: ["review dismissed", null] };
    const items = [
      ...(d.comments ?? []).map((c, i) => ({ at: c.createdAt, el: () => this.entry(t, `pr-c-${i}`, c.author?.login ?? "", c.createdAt, "commented", c.body) })),
      ...(d.reviews ?? []).filter((r) => r.state !== "PENDING").map((r, i) => {
        const [verb, accent] = reviewVerb[r.state] ?? ["reviewed", null];
        return { at: r.submittedAt, el: () => this.entry(t, `pr-r-${i}`, r.author?.login ?? "", r.submittedAt, verb, r.body, accent) };
      }),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return v_flex().gap(16)
      .child(this.entry(t, "pr-body", d.author?.login ?? "", d.createdAt, "opened this", d.body?.trim() ? d.body : "_No description provided._"))
      .children(items.map((i) => i.el()))
      .child(this.reviewBox(t, d));
  }

  reviewBox(t, d) {
    const open = d.state === "OPEN";
    const mine = this.me && d.author?.login === this.me;
    const p = this.pending;
    // Never merge on red or unfinished CI, even with bypass: that goes through GitHub.
    if (p?.kind === "merge" && this.ciBlock(d)) this.pending = null;
    return v_flex().gap(8).pt(4)
      .child(div().h(110).rounded(8).border_1().border_color(t.input).bg(t.background).p(8).text_size(13).text_color(t.foreground)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.box).size_full()))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(this.note && !/posted|Approved|requested\.|Merged/.test(this.note) ? t.blocked : t.dim)
          .child(this.posting ? "Posting…" : this.note ?? (mine ? "Your own PR: GitHub only allows comments." : "Posts as you on GitHub after you confirm.")))
        .when(!p, (el) => el
          .child(this.button(t, "pr-comment", "Comment", (_e, cx) => this.ask("comment", cx)))
          .when(open && !mine, (el) => el
            .child(this.button(t, "pr-changes", "Request changes", (_e, cx) => this.ask("changes", cx), "red"))
            .child(this.button(t, "pr-approve", "Approve", (_e, cx) => this.ask("approve", cx), "green"))))
      )
      // The confirm step gets its own block: the prompt wraps above the buttons, so it
      // fits a half-width pane beside a review session.
      .when(Boolean(p), (el) => el.child(v_flex().gap(8).px(12).py(10).rounded(8).border_1()
        .border_color(p.kind === "changes" ? GH.closed + "88" : p.kind === "merge" && this.mergeMode(this.data).mode === "bypass" ? GH.pending + "aa" : t.border)
        .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(`${p.label} on ${props().repo}#${props().number}?`))
        .child(h_flex().gap(8).justify_end()
          .child(this.button(t, "pr-cancel", "Cancel", (_e, cx) => { this.pending = null; cx.notify(); }))
          .child(this.button(t, "pr-confirm", "Confirm", (_e, cx) => this.post(cx), p.kind === "changes" ? "red" : p.kind === "merge" ? (this.mergeMode(this.data).mode === "bypass" ? "amber" : "purple") : "green")))))
      .when(open && !d.isDraft && !p, (el) => el.child(this.mergeBar(t, d)));
  }

  // "fail" or "run" when CI is red or unfinished; merging is off until it is green.
  ciBlock(d) {
    const list = d.statusCheckRollup ?? [];
    if (list.some((c) => checkState(c) === "fail")) return "fail";
    if (list.some((c) => checkState(c) === "run")) return "run";
    return null;
  }

  // Merge only on green CI. Red CI points to GitHub instead, and a
  // failing semver-label check offers the label picker, since that is fixable here.
  mergeBar(t, d) {
    const block = this.ciBlock(d);
    const checks = d.statusCheckRollup ?? [];
    if (block) {
      const failing = checks.filter((c) => checkState(c) === "fail");
      const semver = failing.some((c) => /semver/i.test(c.name ?? "")) && failing.length === 1;
      const title = block === "fail"
        ? `${failing.length} check${failing.length > 1 ? "s" : ""} failing: ${failing.map((c) => c.name).join(", ")}`
        : `${this.runningChecks()} check${this.runningChecks() > 1 ? "s" : ""} still running`;
      const help = block === "run" ? "Merge turns on when every check passes."
        : semver ? "Only the semver label is missing. Add one and the check re-runs."
        : "Merging is off while CI fails. Fix it on GitHub.";
      return h_flex().mt(6).px(12).py(10).gap(10).items_center().rounded(8).border_1()
        .border_color(block === "fail" ? GH.closed + "88" : GH.pending + "88")
        .child(svg("mods/board-strip/icons/pr-merged.svg").size(16).text_color(t.dim))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13).font_semibold().text_color(block === "fail" ? GH.closed : GH.pending).child(title))
          .child(div().text_size(12).text_color(t.dim).child(help)))
        .when(semver, (el) => el.child(this.button(t, "pr-add-semver", "Add semver label", null, "green")
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press = e; })
          .on_click((_e, cx) => this.openMenu("labels", cx, { current: (d.labels ?? []).map((l) => l.name) }, this.press, true))))
        .when(block === "fail" && !semver, (el) => el.child(this.button(t, "pr-gh-checks", "Open checks on GitHub", () => exec("open", [`${d.url}/checks`]))));
    }
    const m = this.mergeMode(d);
    if (m.mode === "wait" || m.mode === "block") {
      return h_flex().mt(6).px(12).py(10).gap(10).items_center().rounded(8).border_1()
        .border_color(m.mode === "block" ? GH.closed + "88" : t.border)
        .child(svg("mods/board-strip/icons/pr-merged.svg").size(16).text_color(t.dim))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13).font_semibold().text_color(m.mode === "block" ? GH.closed : t.muted).child(m.title))
          .child(div().text_size(12).text_color(t.dim).child(m.help)))
        .when(m.mode === "block", (el) => el.child(this.button(t, "pr-gh-merge", "Open on GitHub", () => exec("open", [d.url]))));
    }
    const bypass = m.mode === "bypass";
    return h_flex().mt(6).px(12).py(10).gap(10).flex_wrap().items_center().rounded(8).border_1().border_color(bypass ? GH.pending + "aa" : GH.open + "88")
      .child(svg("mods/board-strip/icons/pr-merged.svg").size(16).text_color(GH.merged))
      .child(v_flex().flex_1().min_w(200)
        .child(div().text_size(13).font_semibold().text_color(bypass ? GH.pending : t.foreground).child(m.title))
        .child(div().text_size(12).text_color(t.dim).child(m.help)))
      .child(div().id("pr-del").flex_none().px(8).h(28).rounded(6).flex().items_center().gap(6).cursor_pointer().text_size(12)
        .text_color(this.deleteBranch ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.deleteBranch = !this.deleteBranch; cx.notify(); })
        .child(div().size(12).rounded(3).border_1().border_color(t.input).when(this.deleteBranch, (e) => e.bg(GH.merged)))
        .child("Delete branch"))
      .child(div().id("pr-method").flex_none().px(8).h(28).rounded(6).border_1().border_color(t.border).flex().items_center()
        .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press = e; })
        .on_click((_e, cx) => this.openMenu("method", cx, {}, this.press, true))
        .child(`${METHOD_NAMES[this.method] ?? "…"} ▾`))
      .child(this.button(t, "pr-merge", bypass ? "Merge with bypass" : "Merge", (_e, cx) => this.ask("merge", cx), bypass ? "amber" : "purple"));
  }

  // Whether GitHub lets this PR merge as is (normal), only with --admin (bypass), or not
  // at all from here (block). GitHub computes mergeStateStatus on demand: UNKNOWN means
  // ask again shortly.
  mergeMode(d) {
    const s = d.mergeStateStatus;
    if (s === "UNKNOWN" || !s) {
      if ((this.unknownTries ?? 0) < 5 && !this.unknownTimer) {
        this.unknownTries = (this.unknownTries ?? 0) + 1;
        this.unknownTimer = true;
        this.cx?.timer.after(3000, (cx) => { this.unknownTimer = false; this.load(cx); });
      }
      return { mode: "wait", title: "Checking mergeability…", help: "GitHub is working out whether this can merge." };
    }
    this.unknownTries = 0;
    if (s === "DIRTY") return { mode: "block", title: "Merge conflicts", help: "Resolve the conflicts on GitHub, or ask the author to rebase." };
    if (s === "BEHIND") return { mode: "block", title: "Branch is behind its base", help: "Update the branch on GitHub, then merge." };
    if (s === "BLOCKED") {
      const why = d.reviewDecision === "REVIEW_REQUIRED" ? "it needs an approving review"
        : d.reviewDecision === "CHANGES_REQUESTED" ? "changes were requested" : "a branch protection rule blocks it";
      return { mode: "bypass", title: "Merging bypasses branch protection", help: `GitHub would block this merge: ${why}. Bypass uses your admin rights.`, why };
    }
    const reviewed = d.reviewDecision === "APPROVED";
    return { mode: "normal", title: reviewed ? "Approved, ready to merge" : "Ready to merge", help: "A normal merge: nothing is bypassed." };
  }

  checks(t, d) {
    const list = d.statusCheckRollup ?? [];
    if (!list.length) return div().text_size(13).text_color(t.dim).child("No checks on this PR.");
    const color = { fail: GH.closed, pass: GH.open, run: GH.pending };
    const word = { fail: "Failing", pass: "Passed", run: "Running" };
    const order = { fail: 0, run: 1, pass: 2 };
    return v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden()
      .children([...list].sort((a, b) => order[checkState(a)] - order[checkState(b)]).map((c, i) => {
        const s = checkState(c);
        return h_flex().id(`pr-chk-${i}`).px(14).h(38).gap(10).items_center().border_b(1).border_color(t.border)
          .when(Boolean(c.detailsUrl || c.targetUrl), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => exec("open", [c.detailsUrl || c.targetUrl])))
          .child(div().size(9).flex_none().rounded(5).bg(color[s]))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(`${c.workflowName ? `${c.workflowName} / ` : ""}${c.name || c.context || "check"}`))
          .child(div().flex_none().text_size(12).text_color(color[s]).child(word[s]));
      }));
  }

  files(t, d) {
    if (this.diffLoading) return div().p(16).text_size(13).text_color(t.dim).child("Loading diff…");
    if (this.diffError) return div().p(16).text_size(13).text_color(t.blocked).child(this.diffError);
    const stats = new Map((d.files ?? []).map((f) => [f.path, f]));
    const cur = this.diff?.find((f) => f.path === this.file);
    const rows = cur?.rows ?? [];
    const mono = settings().font_family ?? "JetBrains Mono";
    const b = this.traceOn ? this.blame : null;
    const row = (r, i) => {
      if (r.kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(r.text);
      const own = this.owners(this.file, r);
      const turn = own ? b.turns[own[0]] : null;
      const untraced = b && r.kind === "+" && !own && r.text.trim().length > 2;
      const dim = b && this.focusTurn && (r.kind !== "+" || own?.[0] !== this.focusTurn);
      const picked = this.sel && this.sel.path === this.file && this.sel.line === r.next && r.kind === "+";
      return h_flex().w_full().h(20).flex_none().gap(8)
        .when(r.kind === "+", (e) => e.bg("#2ea04326")).when(r.kind === "-", (e) => e.bg("#f8514926"))
        .when(picked, (e) => e.bg(t.selected))
        .when(Boolean(dim), (e) => e.opacity(0.35))
        .when(Boolean(b), (e) => e.child(div().w(4).h(16).flex_none().rounded(1)
          .when(Boolean(turn), (m) => m.bg(turnColor(turn.n)))
          .when(untraced, (m) => m.border_1().border_color(t.dim))))
        .when(Boolean(turn), (e) => e.cursor_pointer())
        .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.old === undefined ? "" : String(r.old)))
        .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.next === undefined ? "" : String(r.next)))
        .child(div().w(10).flex_none().text_color(r.kind === "+" ? GH.open : r.kind === "-" ? GH.closed : t.dim).child(r.kind === " " ? "" : r.kind))
        .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(t.foreground).child(r.text));
    };
    return h_flex().size_full().min_h(0).items_start()
      .child(v_flex().id("pr-files").w(260).flex_none().h_full().overflow_y_scrollbar().p(6).gap(1).border_r(1).border_color(t.border)
        .children((this.diff ?? []).map((f) => {
          const s = stats.get(f.path) ?? {};
          const parts = f.path.split("/"), name = parts.pop();
          let share = null;
          if (b) {
            const plus = f.rows.filter((r) => r.kind === "+" && r.text.trim().length > 2).length;
            const owned = Object.keys(b.files?.[f.path] ?? {}).length;
            share = plus ? Math.min(100, Math.round((100 * owned) / plus)) : null;
          }
          return h_flex().id(`pr-f-${f.path}`).px(8).h(28).flex_none().gap(6).items_center().rounded(6).cursor_pointer()
            .when(f.path === this.file, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
            .tooltip(f.path).on_click((_e, cx) => { this.file = f.path; cx.notify(); })
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(name))
            .when(share !== null, (e) => e.child(div().id(`pr-share-${f.path}`).flex_none().text_size(10.5).text_color(share >= 90 ? t.dim : GH.pending).tooltip("Share of added lines traced to a Claude turn").child(`${share}%`)))
            .child(div().flex_none().text_size(11).text_color(GH.open).child(`+${s.additions ?? 0}`))
            .child(div().flex_none().text_size(11).text_color(GH.closed).child(`−${s.deletions ?? 0}`));
        })))
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(h_flex().px(12).h(32).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.muted).child(this.file ?? ""))
          .when(Boolean(this.traceError), (e) => e.child(div().id("pr-trace-error").flex_none().max_w(360).truncate().text_size(11.5).text_color(t.blocked).tooltip(this.traceError).child(this.traceError)))
          .when(Boolean(b), (e) => e.child(div().id("pr-trace-stats").flex_shrink(1).min_w(0).truncate().text_size(11.5).text_color(t.dim)
            .tooltip("Click a marked line to see the turn that wrote it")
            .child(`${b.stats.traced} traced · ${b.stats.untraced} not`)))
          .child(div().id("pr-trace").flex_none().px(8).h(22).rounded(6).border_1().flex().items_center().text_size(11.5).cursor_pointer()
            .border_color(this.traceOn ? t.accent : t.border).bg(this.traceOn ? t.accent + "22" : t.raised)
            .text_color(this.traceOn ? t.accent : t.foreground).hover((s) => s.opacity(0.88))
            .tooltip("Show which Claude turn wrote each added line")
            .on_click((_e, cx) => this.trace(cx))
            .child(this.tracing ? "Tracing…" : this.traceOn ? "Trace on" : "Trace")))
        .child(div().flex_1().min_h(0).relative().font_family(mono).text_size(12)
          .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(1200).h_full().child(v_virtual_list("pr-diff", rows.length, 20, (i) => `${this.file}:${i}`,
              (range) => rows.slice(range.start, range.end).map((r, k) => row(r, range.start + k))).size_full()
              // Rows may not register handlers; the list reports the clicked row's key.
              .on_item_click((key, cx) => {
                const r = rows[Number(key.slice(key.lastIndexOf(":") + 1))];
                const own = r && this.owners(this.file, r);
                if (own) this.pick(own[0], cx, { turn: own[0], path: this.file, line: r.next, owners: own });
              }))))
          .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(b && this.sel), (el) => el.child(this.blamePanel(t)));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu === "method") return this.methodMenu(t);
    if (props()?.menu === "labels") return this.labelMenu(t);
    // A label changed from the picker: load again so checks and labels catch up.
    const signal = shared("pr.refresh") ?? 0;
    if (signal !== this.refreshSeen) { this.refreshSeen = signal; this.fetch(cx); }
    const d = this.data;
    if (!d) {
      return v_flex().size_full().bg(t.background).items_center().justify_center().text_size(13)
        .text_color(this.error ? t.blocked : t.dim).child(this.error ?? "Loading pull request…");
    }
    const checks = d.statusCheckRollup ?? [];
    const failing = checks.filter((c) => checkState(c) === "fail").length;
    const running = checks.filter((c) => checkState(c) === "run").length;
    const ciText = !checks.length ? null : failing ? `${failing} of ${checks.length} checks failing` : running ? `${running} checks running` : "All checks passed";
    const ciColor = failing ? GH.closed : running ? GH.pending : GH.open;
    const tab = (id, label) => div().id(`pr-tab-${id}`).px(12).h(36).flex().items_center().text_size(13).cursor_pointer()
      .border_b(2).border_color(this.view === id ? "#f78166" : t.background)
      .text_color(this.view === id ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.show(id, cx)).child(label);

    const header = v_flex().gap(8).px(28).pt(22).pb(0).flex_none()
      .child(h_flex().gap(10).items_start()
        .child(div().flex_1().min_w(0).text_size(22).text_color(t.foreground).child(d.title))
        .child(div().flex_none().pt(2).text_size(22).text_color(t.dim).child(`#${d.number}`))
        // Not shown inside a review space, which already has its Claude session.
        .when(d.state === "OPEN" && !(focused()?.cwd ?? "").includes(`/pr-${d.number}`), (el) => el.child(
          this.button(t, "pr-review", this.reviewing ? "Opening…" : "Review with Claude", (_e, cx) => this.startReview(cx), "green")))
        .child(this.button(t, "pr-refresh", this.loading ? "Refreshing…" : "Refresh", (_e, cx) => this.fetch(cx)))
        .child(this.button(t, "pr-open", "Open on GitHub", () => exec("open", [d.url]))))
      .child(h_flex().gap(8).items_center().flex_wrap().text_size(13).text_color(t.muted)
        .child(this.pill(t, d))
        .child(div().child(`${d.author?.login ?? ""} wants to merge ${d.commits?.length ?? "?"} commit${d.commits?.length === 1 ? "" : "s"} into`))
        .child(div().px(6).rounded(5).bg(t.raised).font_family("JetBrains Mono").text_size(12).text_color(t.accent).child(d.baseRefName))
        .child(div().child("from"))
        .child(div().px(6).rounded(5).bg(t.raised).font_family("JetBrains Mono").text_size(12).text_color(t.accent).child(d.headRefName))
        .child(div().text_color(GH.open).child(`+${d.additions}`))
        .child(div().text_color(GH.closed).child(`−${d.deletions}`))
        .when(Boolean(ciText), (el) => el.child(div().text_color(ciColor).child(`· ${ciText}`))))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .children((d.labels ?? []).map((l) =>
          div().px(8).h(22).rounded(11).bg(`#${l.color}`).text_size(12).font_medium().text_color(ink(l.color)).flex().items_center().child(l.name)))
        .when(d.state === "OPEN", (el) => el.child(div().id("pr-labels").px(8).h(22).rounded(11).border_1().border_color(t.border)
          .text_size(12).text_color(t.muted).flex().items_center().cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press = e; })
          .on_click((_e, cx) => this.openMenu("labels", cx, { current: (d.labels ?? []).map((l) => l.name) }, this.press, false))
          .child((d.labels ?? []).length ? "Edit labels" : "+ Add labels"))))
      .child(h_flex().pt(6).border_b(1).border_color(t.border)
        .child(tab("conversation", `Conversation ${(d.comments?.length ?? 0) + (d.reviews?.length ?? 0) || ""}`.trim()))
        .child(tab("files", `Files changed ${d.changedFiles}`))
        .child(tab("checks", `Checks ${checks.length || ""}`.trim())));

    const body = this.view === "files"
      ? div().flex_1().min_h(0).child(this.files(t, d))
      : v_flex().id(`pr-scroll-${this.view}`).flex_1().min_h(0).overflow_y_scrollbar().mode("always")
          .child(div().w_full().max_w(1000).px(28).py(18).child(this.view === "checks" ? this.checks(t, d) : this.conversation(t, d)));

    return v_flex().size_full().min_h(0).bg(t.background).child(header).child(body);
  }
}
