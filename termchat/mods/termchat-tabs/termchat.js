// termchat in the right panel: a tab-bar button with the unread count that opens
// the panel's "termchat" view, a block showing the kept terminal named
// "termchat" (`{ "terminal": "termchat" }` in the layout).

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, exec, home, settings, layout } from "herdr";

// The terminal the panel block names. The block resolves it by name, so a
// terminal started again under the same name shows in the same place.
export const TERMCHAT_TERMINAL = "termchat";
const POLL_MS = 5000;
// termchat's panel width before the person has chosen one: this share of the
// window's width, in layout pixels (unscaled by zoom).
const WIDTH_SHARE = 0.5;

export function termchatDefaultPx() {
  try {
    const w = globalThis.window;
    const width = w?.bounds?.()?.width ?? w?.viewport_size?.()?.width;
    if (!width) return null;
    return Math.round((width * WIDTH_SHARE) / (settings()?.zoom ?? 1));
  } catch { return null; }
}

// startUnread polls `termchat chats --json` and keeps view.termchatUnread, the
// total unread messages, current. null means termchat could not be asked (not
// installed, no account): the button then shows no count.
export function startUnread(view, cx) {
  view.termchatUnread = null;
  const poll = (cx) => cx.spawn(async (cx) => {
    let n = null;
    try {
      const r = await exec("termchat", ["chats", "--json"], { timeout: 4000 });
      if (r.code === 0) n = JSON.parse(r.stdout).reduce((sum, c) => sum + (c.unread ?? 0), 0);
    } catch { n = null; }
    if (n !== view.termchatUnread) { view.termchatUnread = n; cx.notify(); }
  });
  poll(cx);
  cx.timer.every(POLL_MS, poll);
}

// The terminal runs termchat in a loop. Herdr closes a pane whose program
// exits and removes its block from the layout, so quitting termchat must not
// end the terminal: it waits for enter and opens termchat again.
const LOOP = "while :; do termchat; printf '\\ntermchat closed. Press enter to open it again.'; read _; done";

// ensureTerminal starts the kept termchat terminal when none is live. It runs
// from the app, so the terminal has no parent agent and outlives any session.
async function ensureTerminal() {
  try {
    const r = await exec("hc", ["get", TERMCHAT_TERMINAL, "--json"], { timeout: 4000 });
    if (r.code === 0 && JSON.parse(r.stdout).state === "live") return;
  } catch { /* not found: start it */ }
  await exec("hc", ["rm", TERMCHAT_TERMINAL], { timeout: 4000 }).catch(() => {});
  await exec("hc", ["run", "--bg", "--keep", "--no-notify", "--name", TERMCHAT_TERMINAL, "--", "sh", "-c", LOOP],
    { cwd: home(), timeout: 10000 });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ensureBlock puts the termchat view back into the panel stack, after
// "projects", when it is missing (removed when an earlier terminal ended).
function ensureBlock() {
  const root = layout();
  if (!root || find(root, "termchat")) return;
  const tree = JSON.parse(JSON.stringify(root));
  const body = find(tree, "panel-body");
  if (!body?.children) return;
  const at = body.children.findIndex((c) => c.id === "projects");
  body.children.splice(at < 0 ? body.children.length : at + 1, 0,
    { id: "termchat", type: "block", content: { terminal: TERMCHAT_TERMINAL } });
  run("layout.set", { layout: tree });
}

// termchatButton draws the tab-bar button. panel and body are the layout's
// "panel" column and "panel-body" stack; view.openPanel and view.closePanel
// switch the panel and keep each view's width.
export function termchatButton(view, t, panel, body, stop) {
  const on = panel && !panel.hidden && body?.active === "termchat";
  const n = view.termchatUnread ?? 0;
  return h_flex().id("panel-termchat").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
    .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
    .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
    .tooltip(view.termchatUnread === null ? "termchat (not reachable)" : n ? `${n} unread in termchat` : "termchat: nothing unread")
    .on_click((_e, cx) => {
      if (on) { view.closePanel(panel, body); return; }
      cx.spawn(async () => {
        await ensureTerminal();
        ensureBlock();
        view.openPanel("termchat", panel, body);
      });
    })
    .child(svg("mods/termchat-tabs/message-square.svg").size(14))
    .child("termchat")
    .when(n > 0, el => el.child(div().min_w(16).px(4).h(16).rounded(8)
      .bg(t.accent).text_color(t.accent_foreground)
      .text_size(10.5).font_semibold().flex().items_center().justify_center().child(n > 99 ? "99+" : String(n))));
}
