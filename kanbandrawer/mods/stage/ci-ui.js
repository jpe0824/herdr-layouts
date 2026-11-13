// Copied from mods/ci-dash/ui.js (pill, section, tint) and mods/ci-dash/format.js (relTime,
// duration, stateOf, GLYPH): mods cannot import across mod folders. Only the icon folder
// differs (this mod's own icons/).
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

export const icon = (name) => `mods/stage/icons/${name}.svg`;

/** A translucent version of a theme color, for tinted pills. Non-hex colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const mono = () => settings().font_family ?? "JetBrains Mono";

/**
 * A small rounded label. `color` tints the background and colors the text;
 * without it the pill is neutral. `glyph` is a text mark, `symbol` an svg name.
 */
export function pill(t, { label, color, glyph, symbol, spin = false, code = false }) {
  const fg = color || t.muted;
  return h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded(6).text_size(11)
    .bg(color ? tint(color) : tint(t.foreground, "1a")).text_color(fg)
    .when(code, (e) => e.font_family(mono()))
    .when(Boolean(glyph), (e) => e.child(div().flex_none().child(glyph)))
    .when(Boolean(symbol) && !spin, (e) => e.child(svg(icon(symbol)).size(11).flex_none()))
    .when(spin, (e) => e.child(svg(icon("spinner")).size(11).flex_none().spin(900)))
    .child(div().truncate().child(label));
}

/** `NEEDS ATTENTION  2  ─────────`. `meta` is a dim note that shrinks first. */
export function section(t, label, count, color, meta = "") {
  return h_flex().flex_none().w_full().px(14).pt(14).pb(4).gap(8).items_center()
    .child(div().flex_none().text_size(11).font_semibold().text_color(color || t.muted).child(label))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(String(count)))
    .when(Boolean(meta), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)))
    .child(div().flex_1().min_w(8).h(1).bg(t.border));
}

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function duration(from, to = Date.now()) {
  const a = Date.parse(from || ""), b = typeof to === "number" ? to : Date.parse(to || "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "";
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * Maps a run, job or step to a state: "running", "queued", "success",
 * "failure", "warning" or "neutral". `done` is true when it can no longer change.
 */
export function stateOf(item) {
  const status = item?.status, conclusion = item?.conclusion;
  if (status === "in_progress") return { kind: "running", label: "running", done: false };
  if (status === "waiting") return { kind: "gate", label: "awaiting approval", done: false };
  if (status && status !== "completed") return { kind: "queued", label: String(status).replace(/_/g, " "), done: false };
  switch (conclusion) {
    case "success": return { kind: "success", label: "success", done: true };
    case "failure": return { kind: "failure", label: "failed", done: true };
    case "timed_out": return { kind: "failure", label: "timed out", done: true };
    case "startup_failure": return { kind: "failure", label: "startup failure", done: true };
    case "action_required": return { kind: "warning", label: "action required", done: true };
    case "cancelled": return { kind: "neutral", label: "cancelled", done: true };
    case "skipped": return { kind: "neutral", label: "skipped", done: true };
    case "neutral": return { kind: "neutral", label: "neutral", done: true };
    case "stale": return { kind: "neutral", label: "stale", done: true };
    default: return { kind: "neutral", label: conclusion || "completed", done: status === "completed" };
  }
}

export const GLYPH = { success: "✓", failure: "✕", warning: "!", neutral: "–", queued: "○", running: "●", gate: "⏸" };
