/**
 * Pure, DOM-free theme/color helpers shared by the UI (main.ts) and the unit
 * tests: the configurable background + accent settings (W14/W16) and how they
 * resolve into the CSS custom properties the app applies. Kept in their own
 * module (no DOM imports) so tests can exercise the shipped code directly —
 * see tests/web.test.ts.
 */

/** The app's theme choices. */
export type Theme = "light" | "dark";

/** Default background color (muted aquamarine) — the settings picker's
 * default. A calmer, lower-saturation take on the original #7FFFD4. It is
 * the app's TINT (tone-1): since the final W16 revision the app background
 * is the neutral theme tone and the picked color lives in the surfaces
 * (input, buttons, even-depth panes, tone-2 shades for pane heads). */
export const DEFAULT_BG = "#A6DDCF";
/** Default accent color — the dark-mode progress-bar orange, shared by both
 * themes (it replaces the old light-mode red). */
export const DEFAULT_ACCENT = "#EF6A5E";
/** Default background intensity: 100% = the picked color IS the background. */
export const DEFAULT_BG_MIX = 100;
/** The theme base the picked color blends with at <100% intensity. */
export const LIGHT_BASE = "#FFFFFF";
export const DARK_BASE = "#000000";

/** True when s is a 6-digit hex color like "#1a2B3c" (3-digit shorthand and
 * anything else are rejected). */
export function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Linear RGB lerp between two #rrggbb colors; t is clamped to 0..1 (0 →
 * base, 1 → picked). Returns a lowercase #rrggbb string.
 */
export function mixHex(base: string, picked: string, t: number): string {
  const b = hexToRgb(base);
  const p = hexToRgb(picked);
  const tt = Math.min(1, Math.max(0, t));
  const ch = (i: number): string =>
    Math.round(b[i]! + (p[i]! - b[i]!) * tt).toString(16).padStart(2, "0");
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/**
 * The effective background for a theme: the theme base (white in light mode,
 * black in dark mode) blended toward the picked color by mix% (0..100). A
 * non-hex picked color falls back to the plain theme base.
 */
export function effectiveBg(theme: Theme, color: string, mix: number): string {
  const base = theme === "dark" ? DARK_BASE : LIGHT_BASE;
  if (!isHexColor(color)) return base;
  return mixHex(base, color, mix / 100);
}

/** In dark mode the picked color is scaled toward black before it becomes the
 * tint, so tinted surfaces (the input, buttons, even-depth panes) stay dark
 * enough for the light ink to read — the raw pastel at 100% behind near-white
 * text would be illegible. 0.45 = the fraction of the picked color that
 * survives; the neutral app background is unaffected (it is the theme base). */
export const DARK_TINT_SCALE = 0.45;

/**
 * The effective TINT (tone-1) for a theme: same blend as effectiveBg, but
 * capped in dark mode so tinted surfaces keep dark, readable shades of the
 * picked color. This is what main.ts applies as `--tint` — the tone-1 used
 * by the input, the command buttons and the even-depth (top-level) result
 * panes.
 */
export function effectiveTint(theme: Theme, color: string, mix: number): string {
  const m = theme === "dark" ? mix * DARK_TINT_SCALE : mix;
  return effectiveBg(theme, color, m);
}
