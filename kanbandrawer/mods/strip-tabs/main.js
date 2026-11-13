// The tab bar for the kanbandrawer layout, cloned from Herdr's `tabs`. The right panel is
// global: its open/closed state and view stay the same across every space.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, nextCommand, openOverlay, theme, window, shared, setShared, layout, settings, home, readTextFile, watchFolder, exec, notify } from "herdr";

// Deploy gates across the org (config.json "org"): runs held by an environment's required
// reviewers. Polled here, because the tab bar always runs, and published as shared "ci.gates"
// for the gate badge and the stage column's banner. No org, no gates.
const GATE_POLL_MS = 120000;
// Only repos pushed to recently can hold a fresh gate; this bounds the API calls per poll.
const GATE_REPO_DAYS = 7;

async function ghJson(path) {
  const r = await exec("gh", ["api", "--header", "Accept: application/vnd.github+json", path], { timeout: 30000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.code}`);
  return JSON.parse(r.stdout);
}

async function readOrg() {
  try { return JSON.parse((await readTextFile(`${home()}/.claude/herdr/config.json`)) ?? "{}").org ?? ""; } catch { return ""; }
}

async function findGates() {
  const org = await readOrg();
  if (!org) return [];
  const since = Date.now() - GATE_REPO_DAYS * 86400000;
  const repos = (await ghJson(`orgs/${org}/repos?sort=pushed&direction=desc&per_page=50`))
    .filter((r) => !r.archived && Date.parse(r.pushed_at) >= since).map((r) => r.full_name);
  const gates = [];
  for (const repo of repos) {
    let waiting;
    try { waiting = (await ghJson(`repos/${repo}/actions/runs?status=waiting&per_page=10`)).workflow_runs ?? []; }
    catch { continue; } // Actions disabled or no access: not a gate.
    for (const w of waiting) {
      const pending = await ghJson(`repos/${repo}/actions/runs/${w.id}/pending_deployments`).catch(() => []);
      const q = new URLSearchParams({ branch: w.head_branch ?? "", per_page: "3" });
      const newer = ((await ghJson(`repos/${repo}/actions/workflows/${w.workflow_id}/runs?${q}`).catch(() => null))?.workflow_runs ?? [])
        .some((r) => r.id > w.id && r.event === w.event);
      gates.push({
        key: `${repo}#${w.id}`, repo, runId: w.id, runNumber: w.run_number, workflow: w.name, title: w.display_title,
        branch: w.head_branch, headSha: w.head_sha, actor: w.triggering_actor?.login ?? w.actor?.login ?? "", url: w.html_url, createdAt: w.created_at, superseded: newer,
        env: pending.map((p) => p.environment?.name).filter(Boolean).join(", "),
        canApprove: pending.some((p) => p.current_user_can_approve),
      });
    }
  }
  return gates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// What a tab nobody named is called, live: a Claude session's own title (it names itself
// after the work), a shell's folder, or the program running. A named tab keeps its name.
const cleanTitle = (title) => String(title ?? "").replace(/^[^\p{L}\p{N}#~]+/u, "").trim();
function tabLabel(c) {
  if (c.named) return c.name;
  const inTab = panes().filter(p => p.tab === c.id);
  const lead = inTab.find(p => p.terminal && p.program?.agent) ?? inTab.find(p => p.terminal && p.focused) ?? inTab.find(p => p.terminal);
  if (!lead) return inTab[0]?.title || c.name;
  const program = lead.program?.name;
  const title = cleanTitle(lead.title);
  if (lead.program?.agent) return title && title !== program && title !== lead.terminal ? title : program ?? c.name;
  if (lead.program?.shell || !program) {
    const h = home();
    if (!lead.cwd) return c.name;
    return lead.cwd === h ? "~" : lead.cwd.split("/").pop();
  }
  return program;
}

// The right panel's views in tab-bar button order, for strip-tabs.panel-next.
const PANEL_ORDER = ["files", "changes", "reviews", "projects"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // shared "stage.available" persists across launches, but only a running stage copy can
    // refresh it, and a copy starts only once its column is shown. A `false` left from the last
    // launch would grey out the toggle that is the only way to show it. Clear it here: unset reads
    // as available, and a running stage copy rewrites the real value on its next sync.
    setShared("stage.available", null);
    // Team PRs waiting on you, for the Reviews button's badge.
    this.reviewKeys = [];
    const dir = `${home()}/.claude/herdr`;
    const read = async () => {
      try { this.reviewKeys = (JSON.parse((await readTextFile(`${dir}/reviews.json`)) ?? "{}").prs ?? []).map((p) => p.key); }
      catch { this.reviewKeys = []; }
    };
    cx.spawn(async (cx) => {
      await read();
      cx.notify();
      for (;;) {
        try { await watchFolder(dir); } catch { return; }
        await read();
        cx.notify();
      }
    });
    this.gatesKnown = null;
    this.pollGates(cx);
    cx.timer.every(GATE_POLL_MS, (cx) => this.pollGates(cx));
    // A check now can be asked for through shared "ci.gates.refresh".
    this.gatesAsked = shared("ci.gates.refresh") ?? 0;
    // strip-tabs.panel-next (cmd-alt-p in this layout) cycles the right panel's views.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "panel-next") this.panelNext();
        // cmd-shift-\\: the stage column toggle, a no-op where the space has no stage view.
        if (c === "stage-toggle" && shared("stage.available") !== false) run("layout.toggle", { id: "stage" });
        cx.notify();
      }
    });
    cx.timer.every(1000, (cx) => {
      const asked = shared("ci.gates.refresh") ?? 0;
      if (asked > this.gatesAsked) { this.gatesAsked = asked; this.pollGates(cx); }
    });
  }

  pollGates(cx) {
    if (this.gatesBusy) return;
    this.gatesBusy = true;
    cx.spawn(async (cx) => {
      try {
        const gates = await findGates();
        // Toast only gates that appeared since the last poll, never the ones found at start.
        if (this.gatesKnown) {
          for (const g of gates) if (!this.gatesKnown.has(g.key)) notify({
            title: `Deploy gate: ${g.repo.split("/")[1]}`,
            body: `${g.title || g.workflow} · ${g.env || "environment"} awaiting approval${g.canApprove ? "" : " (not yours)"}`,
            level: "warning",
          });
        }
        this.gatesKnown = new Set(gates.map((g) => g.key));
        // Always written, so the panel can show when gates were last checked.
        setShared("ci.gates", { at: Date.now(), gates });
      } catch (e) {
        // gh missing, offline or rate limited: keep the last list, and say the check failed.
        const prev = shared("ci.gates") ?? {};
        setShared("ci.gates", { ...prev, gates: prev.gates ?? [], failedAt: Date.now(), error: String(e?.message ?? e) });
      } finally {
        this.gatesBusy = false;
        cx.notify();
      }
    });
  }

  // Hidden: show the panel on what it last showed. Shown: the next view in button order,
  // wrapping, skipping any view without a button. Same calls as the buttons, so the
  // panel buttons stay consistent.
  panelNext() {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return;
    if (panel.hidden) return run("layout.show", { id: "panel" });
    const enabled = this.enabled ?? PANEL_ORDER;
    const order = PANEL_ORDER.filter((id) => enabled.includes(id));
    if (!order.length) return;
    const next = order[(order.indexOf(body.active) + 1) % order.length];
    run("layout.select", { stack: "panel-body", child: next });
    run("layout.show", { id: "panel" });
  }

  // Deploy gates waiting anywhere in the org, as an amber pause + count just left of the
  // stage toggle. Shown only while there are any; a click opens the first one's run.
  gateBadge(t, stop) {
    const gates = shared("ci.gates")?.gates ?? [];
    if (!gates.length) return null;
    const amber = "#d29922";
    const tip = gates.map((g) => `${g.repo} · ${g.title || g.workflow} · ${g.env || "environment"}${g.actor ? ` · by ${g.actor}` : ""}`).join("\n");
    const url = (g) => g.url ?? `https://github.com/${g.repo}/actions/runs/${g.runId}`;
    return h_flex().id("gate-badge").h(26).px(7).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).font_semibold().text_color(amber).bg(t.chrome).hover(s => s.bg(t.hover))
      .on_mouse_down("left", stop).tooltip(tip)
      .on_click(() => exec("open", [url(gates[0])]))
      .child("\u23F8")
      .child(String(gates.length));
  }

  // Reviews: the count of PRs waiting on you; solid with a red dot while any is unseen.
  reviewsButton(t, panel, body, stop) {
    const on = panel && !panel.hidden && body?.active === "reviews";
    const n = this.reviewKeys.length;
    const seen = new Set(shared("reviews.seen") ?? []);
    const fresh = this.reviewKeys.some((k) => !seen.has(k));
    return h_flex().id("panel-reviews").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .tooltip(n ? `${n} PR${n > 1 ? "s" : ""} waiting on your review${fresh ? " (new)" : ""}` : "No PRs waiting on you")
      .on_click(() => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "reviews" }); run("layout.show", { id: "panel" }); }
      })
      .child(svg("mods/board-strip/icons/pr-open.svg").size(14))
      .child("Reviews")
      .when(n > 0, el => el.child(div().min_w(16).px(4).h(16).rounded(8)
        .bg(fresh ? t.accent : t.raised).text_color(fresh ? t.accent_foreground : t.muted)
        .text_size(10.5).font_semibold().flex().items_center().justify_center().child(String(n))))
      .when(fresh, el => el.child(div().size(7).rounded(4).bg(t.blocked)));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = tabLabel(c);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().id(`tab-name-${c.id}`).max_w(220).truncate().when(name.length > 28, el => el.tooltip(name)).child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Files and Changes follow the space; a divider then sets off Reviews and
    // Projects, which are the same whatever space is shown. The panel's state is global, not per space.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "reviews", "projects"];
    this.enabled = enabled;
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(div().w(1).h(16).mx(4).flex_none().bg(t.border))
      .child(this.reviewsButton(t, panel, body, stop))
      .child(panelButton("projects", "Projects", "mods/strip-tabs/square-kanban.svg"))
      .when(((shared("ci.gates")?.gates ?? []).length) > 0, el => el.child(this.gateBadge(t, stop)))
      // The stage column's toggle, always at the far right so it never moves.
      .child(div().w(1).h(16).mx(4).flex_none().bg(t.border))
      .child((() => {
        const node = find(root, "stage"), on = Boolean(node) && !node.hidden;
        const avail = shared("stage.available") !== false;
        return div().id("stage-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .bg(on && avail ? t.selected : t.chrome).text_color(avail ? (on ? t.foreground : t.muted) : t.dim)
          .when(avail, el => el.hover(s => s.bg(t.hover)).on_click(() => run(on ? "layout.hide" : "layout.show", { id: "stage" })))
          .when(!avail, el => el.opacity(0.35))
          .on_mouse_down("left", stop)
          .tooltip(avail ? `${on ? "Hide" : "Show"} the stage column (⌘⇧\\)` : "No stage view for this space")
          .child(svg("mods/strip-tabs/panel-right.svg").size(14));
      })())
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/strip-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/strip-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/strip-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
