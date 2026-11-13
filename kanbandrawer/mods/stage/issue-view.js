// Copied from mods/issue/main.js for the stage column (mods cannot import across mod folders).
// Differences: the target comes from the constructor props (`cx.new(IssueView, { repo, issue })`)
// rather than herdr's props(), which belong to the hosting stage copy; the stage re-creates the
// view when the selected card changes. Below NARROW px the side column moves under the timeline.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, exec, home, readTextFile } from "herdr";

const FIELDS = "number,title,state,stateReason,author,createdAt,updatedAt,body,labels,assignees,comments,milestone,url";
const REFRESH_MS = 2 * 60 * 1000;
const NARROW = 760;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 7 * 1440) return `${Math.floor(mins / 1440)}d ago`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ""}`;
}

// A label's text color: dark on light labels, light on dark ones.
function ink(hex) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1f2328" : "#ffffff";
}

export default class IssueView extends View {
  init(p, cx) {
    this.p = p ?? {};
    this.width = null;
    this.data = null;
    this.error = null;
    this.loading = false;
    this.pr = null;
    this.fetch(cx);
    cx.timer.every(REFRESH_MS, (cx) => { this.load(cx); });
    cx.timer.every(60000, (cx) => cx.notify());
  }

  fetch(cx) {
    cx.spawn(async (cx) => this.load(cx));
  }

  async load(cx) {
    const { repo, issue } = this.p;
    if (!repo || !issue) {
      this.error = "This tab needs a repo and an issue number.";
      cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();
    try {
      const r = await exec("gh", ["issue", "view", String(issue), "--repo", repo, "--json", FIELDS], { timeout: 60000 });
      if (r.code === 0) {
        this.data = JSON.parse(r.stdout);
        this.error = null;
        this.fetchedAt = Date.now();
      } else {
        this.error = (r.stderr || "gh issue view failed").trim();
      }
    } catch (e) {
      this.error = String(e);
    }
    // The board card's PR for this issue, if one is open.
    try {
      const text = await readTextFile(`${home()}/.claude/herdr/board.json`);
      const cards = Object.values(JSON.parse(text ?? "{}").cards ?? {});
      this.pr = cards.find((c) => c.repo === repo && c.issue === Number(issue))?.pr ?? null;
    } catch {
      this.pr = null;
    }
    this.loading = false;
    cx.notify();
  }

  button(t, id, label, onClick) {
    return div().id(id).flex_none().px(10).h(28).rounded(6).border(1).border_color(t.border).bg(t.raised)
      .text_size(12).font_medium().text_color(t.foreground).flex().items_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  pill(t, d) {
    const closed = d.state === "CLOSED";
    const color = closed ? (d.stateReason === "NOT_PLANNED" ? t.muted : "#8957e5") : "#1f883d";
    const word = closed ? (d.stateReason === "NOT_PLANNED" ? "Closed as not planned" : "Closed") : "Open";
    return h_flex().flex_none().px(10).h(26).rounded(13).bg(color).gap(6).items_center()
      .text_size(12).font_semibold().text_color("#ffffff").child(word);
  }

  // One timeline entry: an author header over markdown, like a GitHub comment box.
  entry(t, id, who, at, body, opener = false) {
    return v_flex().w_full().rounded(8).border(1).border_color(opener ? t.accent + "66" : t.border).overflow_hidden()
      .child(h_flex().px(12).h(34).gap(6).items_center().bg(opener ? t.accent + "14" : t.surface).border_b(1).border_color(t.border).text_size(12.5)
        .child(div().font_semibold().text_color(t.foreground).child(who))
        .child(div().text_color(t.muted).child(`${opener ? "opened this" : "commented"} ${when(at)}`)))
      .child(div().px(14).py(10).text_size(13.5).text_color(t.foreground)
        .child(body?.trim() ? TextView.markdown(id, body).selectable(true) : div().text_color(t.dim).child("No description provided.")));
  }

  side(t, title, content) {
    return v_flex().gap(6).pb(14).border_b(1).border_color(t.border)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(title))
      .child(content);
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    if (!d) {
      return v_flex().size_full().bg(t.background).items_center().justify_center().text_size(13)
        .text_color(this.error ? t.blocked : t.dim)
        .child(this.error ?? "Loading issue…");
    }
    const open = () => exec("open", [d.url]);
    const comments = d.comments ?? [];
    const labels = d.labels ?? [];
    const assignees = d.assignees ?? [];

    const header = v_flex().gap(8).pb(14).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_start()
        .child(div().flex_1().min_w(0).text_size(22).text_color(t.foreground)
          .child(`${d.title}`))
        .child(div().flex_none().pt(2).text_size(22).text_color(t.dim).child(`#${d.number}`))
        .child(this.button(t, "iss-refresh", this.loading ? "Refreshing…" : "Refresh", (_e, cx) => this.fetch(cx)))
        .child(this.button(t, "iss-open", "Open on GitHub", open)))
      .child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted)
        .child(this.pill(t, d))
        .child(div().child(`${d.author?.login ?? "someone"} opened this issue ${when(d.createdAt)} · ${comments.length} comment${comments.length === 1 ? "" : "s"}`)));

    const timeline = v_flex().flex_1().min_w(0).gap(16)
      .child(this.entry(t, "iss-body", d.author?.login ?? "", d.createdAt, d.body, true))
      .children(comments.map((c, i) => this.entry(t, `iss-c-${i}`, c.author?.login ?? "", c.createdAt, c.body)))
      .child(h_flex().pt(4).gap(8).items_center().text_size(12).text_color(t.dim)
        .child(div().child(`Updated ${when(d.updatedAt)}${this.fetchedAt ? ` · fetched ${when(new Date(this.fetchedAt).toISOString())}` : ""}`))
        .when(this.error != null, (el) => el.child(div().text_color(t.blocked).child(this.error))));

    const narrow = this.width !== null && this.width < NARROW;
    const sidebar = v_flex().when(narrow, (el) => el.w_full()).when(!narrow, (el) => el.w(240)).flex_none().gap(14)
      .child(this.side(t, "Assignees", assignees.length
        ? v_flex().gap(4).children(assignees.map((a) => div().text_size(13).text_color(t.foreground).child(a.login)))
        : div().text_size(13).text_color(t.dim).child("No one assigned")))
      .child(this.side(t, "Labels", labels.length
        ? h_flex().flex_wrap().gap(6).children(labels.map((l) => div().px(8).h(22).rounded(11).bg(`#${l.color}`)
            .text_size(12).font_medium().text_color(ink(l.color)).flex().items_center().child(l.name)))
        : div().text_size(13).text_color(t.dim).child("None yet")))
      .child(this.side(t, "Milestone", div().text_size(13).text_color(d.milestone ? t.foreground : t.dim).child(d.milestone?.title ?? "No milestone")))
      .child(this.side(t, "Development", this.pr?.number
        ? div().id("iss-pr").text_size(13).text_color(t.accent).cursor_pointer().on_click(() => exec("open", [this.pr.url]))
            .child(`PR #${this.pr.number}${this.pr.state ? ` · ${this.pr.state.toLowerCase()}` : ""}`)
        : div().text_size(13).text_color(t.dim).child("No pull request yet")));

    return v_flex().id("iss-scroll").size_full().bg(t.background).overflow_y_scrollbar().mode("always")
      .on_size_change((size, cx) => { if (Math.round(size.width) !== Math.round(this.width ?? -1)) { this.width = size.width; cx.notify(); } })
      .child(v_flex().w_full().max_w(1100).px(narrow ? 16 : 28).py(narrow ? 14 : 22).gap(18)
        .child(header)
        .child(narrow
          ? v_flex().gap(20).child(timeline).child(sidebar)
          : h_flex().gap(28).items_start().child(timeline).child(sidebar)));
  }
}
