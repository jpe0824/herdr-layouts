// GitHub Projects in the side panel of the kanbandrawer layout (panel-body child "projects"),
// one block per project, each collapsed by default. Data is ~/.claude/herdr/projects.json,
// written by `herdr-board projects`. Expanded state is shared "projects.expanded" ({[number]: true}).
// The refresh rule, phase bars and item rows are copied from mods/board-full (mods cannot import
// across mod folders); board-full keeps its own copy. An issue opens in mods/issue-q (Queue / Park).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, exec, home, readTextFile, watchFolder, notify, layout, shared, setShared } from "herdr";
import { summary, orderProjects, isExpanded } from "./logic.js";

// Project reads are expensive GraphQL calls: re-read at most this often, and only while shown.
const PROJECTS_EVERY_MS = 15 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_ORDER = ["Done", "In Review", "In Progress", "Todo"];

const shortDate = (iso) => {
  const [, m, d] = String(iso).split("-").map(Number);
  return m && d ? `${MONTHS[m - 1]} ${d}` : String(iso);
};
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
const errText = (r) => (r.stderr || r.stdout || "").trim().replace(/^herdr-board: /, "");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Shown = the panel is open with Projects selected. A stack keeps its other children alive.
function isShown() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "projects");
}

export default class Projects extends View {
  init(_props, cx) {
    this.dir = `${home()}/.claude/herdr`;
    this.bin = `${this.dir}/bin/herdr-board`;
    this.projects = null;
    this.projectsLoading = false;
    // Cheap check (no network unless the file is stale), so opening the panel refreshes promptly.
    cx.timer.every(5000, (cx) => this.maybeRefreshProjects(cx));
    cx.spawn(async (cx) => { await this.readProjects(); this.maybeRefreshProjects(cx); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        await this.readProjects();
        cx.notify();
      }
    });
    // The checked time moves with the clock.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  async readProjects() {
    try {
      const text = await readTextFile(`${this.dir}/projects.json`);
      this.projects = text ? JSON.parse(text) : null;
    } catch {
      this.projects = null;
    }
  }

  // Refreshes only while shown and the file is older than the interval.
  maybeRefreshProjects(cx) {
    if (!isShown() || this.projectsLoading) return;
    const at = Date.parse(this.projects?.checked ?? "");
    if (Number.isFinite(at) && Date.now() - at < PROJECTS_EVERY_MS) return;
    this.refreshProjects(cx);
  }

  refreshProjects(cx) {
    if (this.projectsLoading) return;
    this.projectsLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, ["projects", "--json"], { timeout: 600000 });
      if (r.code !== 0) notify({ title: "Projects check failed", body: errText(r), level: "error" });
      await this.readProjects();
      this.projectsLoading = false;
      cx.notify();
    });
  }

  toggle(p) {
    const state = shared("projects.expanded") ?? {};
    const id = String(p.number);
    setShared("projects.expanded", { ...state, [id]: !isExpanded(state, id) });
  }

  statusColor(t, s) {
    return { Done: t.ansi2, "In Review": t.ansi5, "In Progress": t.ansi3 }[s] ?? t.dim;
  }

  barColor(t, s) {
    return s === "Todo" ? t.border : this.statusColor(t, s);
  }

  openProjectIssue(i) {
    if (!i.repo || !i.number) return;
    const kind = i.type === "PullRequest" ? "pr" : "issue";
    const props = kind === "pr" ? { repo: i.repo, number: i.number } : { repo: i.repo, issue: i.number };
    // Issues open in issue-q, mods/issue plus Queue and Park buttons (herdr-q).
    run("tab.new", { name: `${kind === "pr" ? "PR " : ""}#${i.number}`, mod: kind === "pr" ? "pr" : "issue-q", props });
  }

  // One item: status dot, ref, title, blocked-by / ready tag, assignees.
  projectItem(t, i, key) {
    const repo = (i.repo ?? "").split("/").pop();
    const people = i.assignees?.length
      ? h_flex().flex_none().gap(2).children(i.assignees.map((a) => (a.avatar
        ? div().id(`av-${key}-${a.login}`).flex_none().tooltip(a.login).child(image(a.avatar).size(16).rounded(8))
        : div().id(`av-${key}-${a.login}`).size(16).flex_none().rounded(8).bg(t.raised).tooltip(a.login)
          .text_size(8.5).font_bold().text_color(t.muted).flex().items_center().justify_center().child(a.login.slice(0, 2).toUpperCase()))))
      : null;
    const c = this.statusColor(t, i.status);
    return h_flex().id(`pi-${key}`).px(4).py(3).gap(6).items_center().rounded(5).cursor_pointer().text_size(11.5)
      .hover((s) => s.bg(t.hover))
      .tooltip(`${i.status ?? ""}${i.assignees?.length ? "" : " · unassigned"}`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.openProjectIssue(i); })
      .child(div().size(7).flex_none().rounded(4).when(i.status === "Todo", (el) => el.border_1().border_color(t.dim)).when(i.status !== "Todo", (el) => el.bg(c)))
      .child(div().flex_none().text_color(t.muted).child(`${repo}#${i.number}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(i.title ?? ""))
      .when(i.blocked_by?.length > 0, (el) => el.child(div().flex_none().max_w(120).truncate().px(5).rounded(4)
        .bg(t.blocked + "22").text_size(10).text_color(t.blocked)
        .child(`blocked by ${i.blocked_by.map((r) => r.split("/").pop()).join(", ")}`)))
      .when(Boolean(i.ready), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.ansi2 + "22").text_size(10).text_color(t.ansi2)
        .child("ready")))
      .when(Boolean(people), (el) => el.child(people));
  }

  // One phase as a row: name, its bar split by status, done/total. The current phase is highlighted.
  phaseStep(t, ph, key) {
    const counts = ph.counts ?? {};
    const segs = STATUS_ORDER.map((s) => [s, counts[s] ?? 0]).filter(([, n]) => n > 0);
    const cur = ph.state === "current";
    return h_flex().id(`ph-${key}`).px(6).py(3).gap(6).items_center().rounded(5).text_size(11)
      .bg(cur ? t.accent + "1a" : t.surface)
      .tooltip(`${ph.name}\n${segs.map(([s, n]) => `${n} ${s}`).join(" · ") || "no items"}`)
      .child(div().w(120).flex_none().truncate().text_color(cur ? t.foreground : ph.state === "done" ? t.muted : t.dim).child(ph.name))
      .child(h_flex().flex_1().min_w(0).h(5).rounded(3).overflow_hidden().gap(1).bg(t.raised).when(ph.state === "upcoming", (el) => el.opacity(0.6))
        .children(segs.map(([s, n]) => div().flex_grow(n).flex_basis(0).h_full().bg(this.barColor(t, s)))))
      .child(div().flex_none().text_color(t.dim).child(`${counts.Done ?? 0}/${ph.total ?? 0}`));
  }

  // Triage carries no phases or target: its collapsed line is counts only.
  triageCounts(t, p, s) {
    const n = (status) => s.segments.find((x) => x.status === status)?.count ?? 0;
    const parts = [`${s.open} open`];
    if (n("In Progress")) parts.push(`${n("In Progress")} in progress`);
    if (n("In Review")) parts.push(`${n("In Review")} in review`);
    return h_flex().gap(6).text_size(11).text_color(t.muted).child(div().child(parts.join(" · ")))
      .when(s.blocked > 0, (el) => el.child(div().text_color(t.blocked).child(`${s.blocked} blocked`)));
  }

  projectBlock(t, p, expanded) {
    const s = summary(p);
    const triage = p.title === "Triage";
    const phases = p.phases ?? [];
    const sub = (label, list, k) => (list?.length ? [div().px(4).pt(6).pb(1).text_size(10.5).text_color(t.dim).child(`${label} (${list.length})`),
      ...list.map((i, n) => this.projectItem(t, i, `${p.number}-${k}-${n}`))] : []);
    const empty = !(p.items ?? []).length && !(p.later_blocked ?? []).length && !(p.unphased ?? []).length;
    const head = v_flex().id(`ph-head-${p.number}`).gap(5).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(p); })
      .child(h_flex().gap(6).items_center()
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(expanded ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(p.title ?? ""))
        .when(Boolean(s.target), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(shortDate(s.target))))
        .when(Boolean(p.url), (el) => el.child(div().id(`pu-${p.number}`).flex_none().px(3).rounded(4).text_size(11).text_color(t.dim)
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Open on GitHub")
          .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [p.url]); }).child("↗"))))
      .when(triage, (el) => el.child(div().pl(16).child(this.triageCounts(t, p, s))))
      .when(!triage, (el) => el
        .child(h_flex().ml(16).h(6).rounded(3).overflow_hidden().gap(1).bg(t.raised)
          .children(s.segments.map((seg) => div().flex_grow(seg.count).flex_basis(0).h_full().bg(this.barColor(t, seg.status)))))
        .child(h_flex().pl(16).gap(6).text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().child(s.label))
          .child(div().flex_none().child(`${s.open} open`))
          .when(s.blocked > 0, (e2) => e2.child(div().flex_none().text_color(t.blocked).child(`· ${s.blocked} blocked`)))));
    return v_flex().id(`proj-${p.number}`).flex_none().px(10).py(8).gap(4).rounded(8).border_1().border_color(t.border)
      .hover((st) => st.bg(t.hover + "66"))
      .child(head)
      .when(expanded, (el) => el
        .when(phases.length > 0, (e2) => e2.child(v_flex().pt(4).gap(2).children(phases.map((ph, n) => this.phaseStep(t, ph, `${p.number}-${n}`)))))
        .child(v_flex().pt(2)
          .children((p.items ?? []).map((i, n) => this.projectItem(t, i, `${p.number}-i-${n}`)))
          .when(empty, (e2) => e2.child(div().px(4).py(2).text_size(11.5).text_color(t.dim).child("Nothing open")))
          .children(sub("Later phases · blocked", p.later_blocked, "b"))
          .children(sub("Unphased", p.unphased, "u"))));
  }

  render(cx) {
    const t = theme();
    const data = this.projects;
    const at = Date.parse(data?.checked ?? "");
    const errors = data?.errors ?? [];
    const label = this.projectsLoading ? "Checking GitHub Projects…"
      : errors.length ? `Projects check: ${errors.length} error${errors.length > 1 ? "s" : ""}`
        : Number.isFinite(at) ? `checked ${ago(Date.now() - at)} ago ↻` : "not checked yet ↻";
    const list = orderProjects(data?.projects ?? []);
    const state = shared("projects.expanded") ?? {};
    const bar = h_flex().px(12).h(36).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Projects"))
      .child(div().text_size(11.5).text_color(t.dim).child(String(list.length)))
      .child(div().flex_1())
      .child(div().id("proj-sync").px(6).h(22).rounded(6).text_size(11.5).flex().items_center()
        .text_color(errors.length ? t.blocked : t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(errors.join("\n") || "Check GitHub Projects now")
        .on_click((_e, cx) => this.refreshProjects(cx))
        .child(label));
    const body = list.length
      ? v_flex().id("proj-list").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(10).gap(6)
        .children(list.map((p) => this.projectBlock(t, p, isExpanded(state, String(p.number)))))
      : v_flex().flex_1().items_center().justify_center().px(16).text_size(12).text_color(t.dim)
        .child(this.projectsLoading ? "Reading GitHub Projects…" : "No project data yet. Click the check time to read GitHub Projects.");
    return v_flex().id("root").size_full().min_h(0).bg(t.background).text_size(12.5).text_color(t.foreground).child(bar).child(body);
  }
}
