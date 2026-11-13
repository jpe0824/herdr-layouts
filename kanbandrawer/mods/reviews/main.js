// Team PRs waiting on your review, as a right-hand panel beside Files and Changes.
// Reads ~/.claude/herdr/reviews.json, written by `herdr-board reviews` (the board mod
// runs it every 3 minutes). PRs you have not seen in this panel are marked New; showing
// the panel marks them seen (shared "reviews.seen", which the tab bar's badge reads).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, home, readTextFile, watchFolder, shared, setShared, layout, run, spaces } from "herdr";

const REVIEWS_SPACE = "Reviews";
async function readOrg() {
  try { return JSON.parse((await readTextFile(`${home()}/.claude/herdr/config.json`)) ?? "{}").org ?? ""; } catch { return ""; }
}

const PR_COLOR = { open: "#3fb950", merged: "#a371f7", closed: "#f85149" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export default class Reviews extends View {
  init(_props, cx) {
    this.data = null;
    this.open = new Set();
    this.dir = `${home()}/.claude/herdr`;
    try { this.view = localStorage.getItem("view") === "recent" ? "recent" : "waiting"; } catch { this.view = "waiting"; }
    cx.spawn(async (cx) => {
      await this.read();
      cx.notify();
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        await this.read();
        cx.notify();
      }
    });
    cx.timer.every(60000, (cx) => cx.notify());
  }

  async read() {
    try {
      const text = await readTextFile(`${this.dir}/reviews.json`);
      this.data = text ? JSON.parse(text) : null;
    } catch {
      this.data = null;
    }
  }

  // Shown means: the panel is open and this panel is the one on top.
  shown() {
    const root = layout();
    const panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "reviews");
  }

  badge(t, p) {
    const ci = p.ci?.state;
    const blocked = ci === "fail" || p.review_decision === "CHANGES_REQUESTED";
    const color = blocked ? PR_COLOR.closed : PR_COLOR.open;
    const why = [ci === "fail" ? `CI failing (${p.ci.failing} of ${p.ci.total})` : ci === "run" ? "CI running" : ci === "pass" ? "CI passing" : "No CI",
      p.review_decision === "CHANGES_REQUESTED" ? "changes requested" : p.review_decision === "APPROVED" ? "approved" : null].filter(Boolean).join(" · ");
    return h_flex().id(`rv-ci-${p.number}-${p.repo}`).flex_none().gap(3).items_center().tooltip(why)
      .child(svg("mods/board-strip/icons/pr-open.svg").size(13).text_color(color))
      .child(div().text_size(11.5).font_medium().text_color(color).child(`#${p.number}`));
  }

  // A teammate's PR never opens in the shown space: that space is someone's session.
  // It goes to the PR's own review space ("Review <repo> #<n>", from herdr-review), which
  // already holds the PR beside its Claude, else to a tab in the shared Reviews space.
  // Tabs there are named "<repo> #<n>": two repos can share a PR number, and a tab's props
  // are not readable, so the name is the only key.
  openPr(p) {
    const repo = p.repo.split("/").pop();
    this.remember({ repo: p.repo, number: p.number, title: p.title });
    const own = spaces().find((s) => s.name === `Review ${repo} #${p.number}`);
    if (own) return this.go(own.id);
    const name = `${repo} #${p.number}`;
    const open = (id) => {
      const tab = spaces().find((s) => s.id === id)?.tabs.find((tab) => tab.name === name);
      if (tab) return this.go(id, tab.id);
      this.go(id);
      run("tab.new", { space: id, name, mod: "pr", props: { repo: p.repo, number: p.number } });
    };
    const shared_ = spaces().find((s) => s.name === REVIEWS_SPACE);
    if (shared_) return open(shared_.id);
    // herdr-app do returns the new space; run() returns nothing. space.new starts with a
    // shell tab: the PR replaces it, so the space holds reviews only and closes with the last.
    exec("herdr-app", ["do", "space.new", JSON.stringify({ name: REVIEWS_SPACE, folder: home() })]).then((r) => {
      let made = null;
      try { made = JSON.parse(r.stdout); } catch {}
      if (!made?.space) return;
      open(made.space);
      if (made.tab) run("tab.close", { id: made.tab });
    });
  }

  // Switches to a review, keeping the side panel open: the tab bar otherwise restores the
  // target space's own panel state (closed, for Reviews) on every space switch.
  go(space, tab) {
    setShared("panel.keep", Date.now());
    run("space.select", { id: space });
    if (tab) run("tab.select", { id: tab });
  }

  // Every PR opened for review, newest first (shared "reviews.history", at most 30). It is
  // what the footer shows a tab's title from, and what Recent reopens a closed review from.
  history() { return shared("reviews.history") ?? []; }
  remember(entry) {
    const key = `${entry.repo.split("/").pop()} #${entry.number}`;
    const old = this.history().find((h) => h.key === key);
    const next = { ...old, ...entry, title: entry.title || old?.title || "", key, at: Date.now() };
    setShared("reviews.history", [next, ...this.history().filter((h) => h.key !== key)].slice(0, 30));
  }

  // Reviews open now: tabs in the shared Reviews space, and herdr-review's own spaces.
  openReviews() {
    const byKey = new Map(this.history().map((h) => [h.key, h]));
    const out = [];
    for (const s of spaces()) {
      if (s.name === REVIEWS_SPACE) {
        for (const tab of s.tabs) out.push({ key: tab.name, title: byKey.get(tab.name)?.title ?? "", space: s.id, tab: tab.id, shown: s.active && tab.active });
      } else if (s.name.startsWith("Review ")) {
        const key = s.name.slice("Review ".length);
        out.push({ key, title: byKey.get(key)?.title || "With Claude", space: s.id, tab: null, shown: s.active });
      }
    }
    return out;
  }

  // A review opened some other way (herdr-review, a script) joins the history too. The
  // owner is config.json "org", as herdr-review assumes.
  learn(open, cx) {
    const known = new Set(this.history().map((h) => h.key));
    const fresh = open.filter((o) => !known.has(o.key) && /^\S+ #\d+$/.test(o.key));
    if (!fresh.length) return;
    cx.spawn(async () => {
      const org = await readOrg();
      if (!org) return;
      fresh.forEach((o) => {
        const [repo, n] = o.key.split(" #");
        this.remember({ repo: `${org}/${repo}`, number: Number(n), title: "" });
      });
    });
  }

  // Entries learned without a title get theirs from GitHub, once per panel copy.
  fillTitles(cx) {
    this.asked ??= new Set();
    const missing = this.history().filter((h) => !h.title && !this.asked.has(h.key));
    if (!missing.length) return;
    missing.forEach((h) => this.asked.add(h.key));
    cx.spawn(async () => {
      for (const h of missing) {
        const r = await exec("gh", ["pr", "view", String(h.number), "--repo", h.repo, "--json", "title", "--jq", ".title"]).catch(() => null);
        const title = r?.code === 0 ? r.stdout.trim() : "";
        if (title) setShared("reviews.history", this.history().map((x) => (x.key === h.key ? { ...x, title } : x)));
      }
    });
  }

  footerRow(t, id, key, title, shown, onClick, onClose, closeTip) {
    return h_flex().id(id).px(8).py(5).gap(8).flex_none().rounded(8).items_center()
      .when(shown, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(svg("mods/board-strip/icons/pr-open.svg").size(13).flex_none().text_color(t.muted))
      .child(div().flex_none().text_size(12).font_medium().text_color(t.foreground).child(key))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(title))
      .when(Boolean(onClose), (el) => el.child(div().id(`${id}-x`).flex_none().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip(closeTip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClose(); })
        .child(svg("mods/pane/close.svg").size(12))));
  }

  // Reviews closed since they were opened, newest first.
  recent(open) {
    const openKeys = new Set(open.map((o) => o.key));
    return this.history().filter((h) => !openKeys.has(h.key));
  }

  // The Recent view: click reopens the PR in the Reviews space, × forgets it.
  recentList(t, recent) {
    if (!recent.length) return [div().px(8).py(10).text_size(12).text_color(t.dim).child("No closed reviews yet.")];
    return recent.map((h) => this.footerRow(t, `rv-recent-${h.key}`, h.key, h.title, false,
      () => this.openPr({ repo: h.repo, number: h.number, title: h.title }),
      () => setShared("reviews.history", this.history().filter((x) => x.key !== h.key)),
      "Forget")
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(new Date(h.at).toISOString()))));
  }

  // Reviews open now, under either view.
  openFooter(t, open) {
    if (!open.length) return null;
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().px(14).pt(8).pb(2).gap(7).items_center().text_size(11.5).font_medium().text_color(t.muted)
        .child(div().child("Open")).child(div().text_color(t.dim).child(String(open.length))))
      .child(v_flex().id("rv-open").flex_none().p(6).pt(2).gap(2).children(open.map((o) =>
        this.footerRow(t, `rv-open-${o.space}-${o.tab ?? ""}`, o.key, o.title, o.shown,
          () => this.go(o.space, o.tab),
          () => (o.tab ? run("tab.close", { id: o.tab, confirmed: true }) : run("space.close", { id: o.space })),
          o.tab ? "Close tab" : "Close review space"))));
  }

  // Waiting | Recent, top right. The choice is kept per panel copy.
  toggle(t, waiting, recent) {
    const seg = (key, label, n) => {
      const on = this.view === key;
      return h_flex().id(`rv-view-${key}`).h(24).px(9).gap(5).items_center().rounded(6).cursor_pointer()
        .text_size(12).font_medium()
        .bg(on ? t.raised : t.chrome).text_color(on ? t.foreground : t.muted)
        .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => { this.view = key; try { localStorage.setItem("view", key); } catch {} cx.notify(); })
        .child(div().child(label))
        .when(n > 0, (el) => el.child(div().text_size(11).text_color(on ? t.muted : t.dim).child(String(n))));
    };
    return h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.chrome)
      .child(seg("waiting", "Waiting", waiting))
      .child(seg("recent", "Recent", recent));
  }

  row(t, p, isNew) {
    // The section already names the author.
    const repo = p.repo.split("/").pop();
    const sub = [repo, ago(p.created), p.why, ...(p.others ?? [])].join(" · ");
    return h_flex()
      .id(`rv-${p.key}`)
      .px(8).py(6).gap(9).flex_none().rounded(8).items_start()
      .when(isNew, (el) => el.bg(t.accent + "14"))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${p.head} → ${p.base} · ${p.files} file${p.files === 1 ? "" : "s"}`)
      .on_click(() => this.openPr(p))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(isNew, (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.accent + "33").text_size(10.5)
            .font_semibold().text_color(t.accent).flex().items_center().child("New")))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.title)))
        .child(div().text_size(11.5).text_color(t.dim).child(sub)))
      .child(v_flex().flex_none().items_end().gap(3)
        .child(this.badge(t, p))
        .child(h_flex().gap(4).text_size(11).font_family("JetBrains Mono")
          .child(div().text_color(PR_COLOR.open).child(`+${p.additions}`))
          .child(div().text_color(PR_COLOR.closed).child(`−${p.deletions}`))));
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const prs = d?.prs ?? [];
    const seen = new Set(shared("reviews.seen") ?? []);
    // Opening the panel marks everything seen (which clears the tab bar's dot), but the
    // New tags stay on what was new when it opened, until the panel is closed.
    const shown = this.shown();
    if (!shown) this.newThisLook = null;
    else {
      this.newThisLook ??= new Set();
      for (const p of prs) if (!seen.has(p.key)) this.newThisLook.add(p.key);
      if (prs.some((p) => !seen.has(p.key))) {
        const keys = prs.map((p) => p.key);
        cx.spawn(async () => setShared("reviews.seen", [...new Set([...(shared("reviews.seen") ?? []), ...keys])].slice(-500)));
      }
    }
    const isNew = (p) => (shown ? this.newThisLook.has(p.key) : !seen.has(p.key));
    const checked = d?.checked ? `checked ${ago(d.checked)} ago` : "not checked yet";
    const open = this.openReviews();
    this.learn(open, cx);
    this.fillTitles(cx);
    const recent = this.recent(open);
    return v_flex().size_full().min_h(0).bg(t.chrome).rounded(10).border_1().border_color(t.border).text_size(13)
      .child(h_flex().px(14).h(44).flex_none().items_center().justify_between().border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().font_semibold().text_color(t.foreground).child("Reviews"))
          .child(div().id("rv-checked").text_size(11).truncate().text_color(d?.errors?.length ? t.blocked : t.dim)
            .tooltip((d?.errors ?? []).join("\n") || "GitHub, every 3 minutes")
            .child(d?.errors?.length ? `${d.errors.length} error${d.errors.length > 1 ? "s" : ""}` : checked)))
        .child(this.toggle(t, prs.length, recent.length)))
      .child(v_flex().id("rv-list").flex_1().min_h(0).p(6).gap(2).overflow_y_scrollbar()
        .when(this.view === "recent", (el) => el.children(this.recentList(t, recent)))
        .when(this.view !== "recent", (el) => el
          .when(!prs.length, (el) => el.child(div().px(8).py(10).text_size(12).text_color(t.dim)
            .child(d ? "Nothing waiting on your review." : "Loading…")))
          .children(this.groups(t, prs, isNew))))
      .children([this.openFooter(t, open)].filter(Boolean));
  }

  // One section per author (a bot's PRs are its own section), most PRs first, ties by
  // whoever has waited longest. Every PR counts and alerts; sections only sort the list.
  groups(t, prs, isNew) {
    const byAuthor = new Map();
    for (const p of prs) {
      const name = p.bot ? p.author.replace(/\[bot\]$/, "").replace(/^./, (c) => c.toUpperCase()) : p.author;
      if (!byAuthor.has(name)) byAuthor.set(name, []);
      byAuthor.get(name).push(p);
    }
    const oldest = (list) => Math.min(...list.map((p) => Date.parse(p.created) || Infinity));
    const sections = [...byAuthor.entries()].sort((a, b) => b[1].length - a[1].length || oldest(a[1]) - oldest(b[1]));
    // The author's GitHub avatar when one is cached; without one, just the name.
    const header = (id, label, n, avatar) => {
      const folded = this.open.has(id); // "open" holds folded sections
      return h_flex().id(`rv-sec-${id}`).px(8).pt(10).pb(2).flex_none().gap(7).items_center()
        .text_size(11.5).font_medium().text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { folded ? this.open.delete(id) : this.open.add(id); cx.notify(); })
        .when(Boolean(avatar), (el) => el.child(image(avatar).size(18).flex_none().rounded(9)))
        .child(div().child(label)).child(div().text_color(t.dim).child(String(n))).child(div().flex_1())
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).text_color(t.dim));
    };
    return sections.flatMap(([name, list]) => {
      const failing = list.filter((p) => p.ci?.state === "fail").length;
      const label = failing ? `${name} · ${failing} failing CI` : name;
      const avatar = list.find((p) => p.avatar)?.avatar ?? null;
      return [header(name, label, list.length, avatar), ...(this.open.has(name) ? [] : list.map((p) => this.row(t, p, isNew(p))))];
    });
  }
}
