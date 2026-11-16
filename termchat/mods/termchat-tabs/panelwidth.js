// Each right-panel view keeps its own width. The width the panel has when a
// view is left (another view chosen, or the panel closed) is saved for that
// view in shared "panel.widths", and restored the next time it opens.

import { run, shared, setShared } from "herdr";

const KEY = "panel.widths";
// A view's width before the person has chosen one: the layout's panel width.
const DEFAULT_PX = 368;

export function rememberWidth(panel, body) {
  const px = panel?.size?.px;
  const id = body?.active;
  if (!panel || panel.hidden || !id || !px) return;
  const widths = shared(KEY) ?? {};
  if (widths[id] === px) return;
  setShared(KEY, { ...widths, [id]: px });
}

// applyWidth sizes the panel for view id: its saved width, else defaults[id]()
// when that gives one, else DEFAULT_PX.
export function applyWidth(id, defaults = {}) {
  const px = (shared(KEY) ?? {})[id] ?? defaults[id]?.() ?? DEFAULT_PX;
  run("layout.resize", { id: "panel", px });
}
