/**
 * Stroke-order widget for kanji result panes: fetches the KanjiVG svg the
 * stroke_order table points at (`./strokes/<svgFile>`, cached by the service
 * worker on first fetch) and animates its strokes in order — each stroke is
 * hidden, then "drawn" by animating its stroke-dashoffset to zero, one after
 * the other. Controls: ‹ steps one stroke backward, › one stroke forward,
 * ↻ replays the whole sequence.
 *
 * Each widget pairs the animation with a font-rendered twin of the kanji
 * (`.stroke-char`) in a box the same size as the animation, so the character
 * is always visible: while the svg loads (a shimmer skeleton fills the
 * animation box), and when the diagram cannot be fetched at all (offline and
 * never cached, missing file) — then the animation box and its controls are
 * removed and only the character remains. Widgets are async decorations: if
 * the pane is gone by the time the svg lands, the figure removes itself.
 */
import type { StrokePage } from "./worker-api.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Fetched svg text per file (the service worker cache makes repeats free). */
const svgCache = new Map<string, Promise<string>>();

function fetchStrokeSvg(file: string): Promise<string> {
  let p = svgCache.get(file);
  if (!p) {
    p = fetch(`./strokes/${file}`).then((res) => {
      if (!res.ok) throw new Error(`stroke svg ${file}: HTTP ${res.status}`);
      return res.text();
    });
    p.catch(() => svgCache.delete(file)); // a failed fetch must not poison the cache
    svgCache.set(file, p);
  }
  return p;
}

/** Ordered stroke path `d` strings of a KanjiVG svg, or null when the svg is
 * unparsable / has no stroke paths. KanjiVG stores one <path> per stroke in
 * the `kvg:StrokePaths_*` group, in stroke order. */
function strokePathsFrom(svgText: string): string[] | null {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.querySelector("svg");
  if (!root) return null;
  const ds = [...root.querySelectorAll('g[id^="kvg:StrokePaths_"] path')]
    .map((p) => p.getAttribute("d") ?? "")
    .filter((d) => d !== "");
  return ds.length > 0 ? ds : null;
}

/** The pieces of one stroke widget the async loader drives. */
interface StrokeFigureParts {
  fig: HTMLElement;
  /** The animation cell: wraps the svg and the loading skeleton. */
  cell: HTMLElement;
  skeleton: HTMLElement;
  bar: HTMLElement;
  svg: SVGElement;
  page: StrokePage;
  prev: HTMLButtonElement;
  replay: HTMLButtonElement;
  next: HTMLButtonElement;
  label: HTMLSpanElement;
}

/** One square animation box with step/replay controls, for one kanji page. */
export function strokeWidgetFigure(page: StrokePage): HTMLElement {
  const fig = document.createElement("figure");
  fig.className = "stroke-widget";

  const row = document.createElement("div");
  row.className = "stroke-row";

  // Font-rendered twin of the animation, in a box the same size: the kanji
  // is visible even while the svg loads and when no diagram exists. Marked
  // aria-hidden — the svg already names the character in its aria-label.
  const char = document.createElement("div");
  char.className = "stroke-char";
  char.textContent = page.literal;
  char.setAttribute("aria-hidden", "true");

  const cell = document.createElement("div");
  cell.className = "stroke-cell";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("stroke-svg");
  svg.setAttribute("viewBox", "0 0 109 109");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `stroke order of ${page.literal}`);
  cell.append(svg);

  // Loading skeleton: a shimmer over the animation box until the strokes land.
  const skeleton = document.createElement("div");
  skeleton.className = "stroke-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  cell.append(skeleton);

  row.append(char, cell);

  const bar = document.createElement("div");
  bar.className = "stroke-bar";
  const label = document.createElement("span");
  label.className = "stroke-label";
  label.textContent = page.literal; // enriched to "食 · 9 strokes" once parsed

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "stroke-prev";
  prev.textContent = "‹";
  prev.title = `Previous stroke of ${page.literal}`;
  prev.setAttribute("aria-label", prev.title);
  prev.disabled = true;

  const replay = document.createElement("button");
  replay.type = "button";
  replay.className = "stroke-replay";
  replay.textContent = "↻";
  replay.title = `Replay the stroke order of ${page.literal}`;
  replay.setAttribute("aria-label", replay.title);
  replay.disabled = true;

  const next = document.createElement("button");
  next.type = "button";
  next.className = "stroke-next";
  next.textContent = "›";
  next.title = `Next stroke of ${page.literal}`;
  next.setAttribute("aria-label", next.title);
  next.disabled = true;

  bar.append(label, prev, replay, next);

  fig.append(row, bar);
  void loadStrokeFigure({ fig, cell, skeleton, bar, svg, page, prev, replay, next, label });
  return fig;
}

async function loadStrokeFigure(parts: StrokeFigureParts): Promise<void> {
  const { fig, cell, skeleton, bar, svg, page, prev, replay, next, label } = parts;
  let ds: string[] | null = null;
  try {
    ds = strokePathsFrom(await fetchStrokeSvg(page.svgFile));
  } catch {
    /* stroke diagram unavailable (offline and never cached, missing file) */
  }
  if (!svg.isConnected) {
    fig.remove();
    return;
  }
  if (!ds) {
    // No diagram: keep the font-rendered character, drop the animation cell
    // (svg + skeleton) and the control bar — without a diagram the count
    // label and the step/replay buttons are meaningless.
    cell.remove();
    bar.remove();
    return;
  }
  skeleton.remove();
  label.textContent = `${page.literal} · ${ds.length} strokes`;

  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("stroke-draw");
  const paths: SVGPathElement[] = [];
  for (const d of ds) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    g.appendChild(p);
    paths.push(p);
  }
  svg.appendChild(g);

  const reduceMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Number of strokes currently drawn (0..paths.length). */
  let step = 0;
  /** Cancellation token: every interaction bumps it, ending a running auto-play. */
  let run = 0;

  /** Draw (true) or hide (false) stroke i; `animate` uses the standard
   * per-stroke transition (a fairly constant drawing speed: short strokes
   * ~0.15s, long ones up to ~0.65s), otherwise the change is instant. */
  function setStroke(i: number, visible: boolean, animate: boolean): void {
    const p = paths[i]!;
    const len = Math.max(p.getTotalLength(), 1);
    p.style.strokeDasharray = `${len}`;
    if (animate) {
      const dur = Math.min(650, Math.max(150, Math.round(len * 1.8)));
      p.style.transition = `stroke-dashoffset ${dur}ms linear`;
    } else {
      p.style.transition = "none";
    }
    p.style.strokeDashoffset = visible ? "0" : `${len}`;
  }

  function syncControls(): void {
    prev.disabled = step === 0;
    next.disabled = step === paths.length;
  }

  /** Auto-play the whole sequence from an empty box (↻). */
  const reveal = async (): Promise<void> => {
    const token = ++run;
    step = 0;
    syncControls();
    // Reset: hide every stroke, no transition yet.
    for (let i = 0; i < paths.length; i++) setStroke(i, false, false);
    if (!svg.isConnected) return;
    for (let i = 0; i < paths.length; i++) {
      if (token !== run || !svg.isConnected) return; // replayed/stepped mid-way: old run stops
      setStroke(i, true, !reduceMotion);
      step = i + 1;
      syncControls();
      if (reduceMotion) continue;
      const len = Math.max(paths[i]!.getTotalLength(), 1);
      const dur = Math.min(650, Math.max(150, Math.round(len * 1.8)));
      await new Promise((r) => setTimeout(r, dur + 60));
    }
  };

  /** Draw the next stroke (›) — cancels any running auto-play. */
  const stepForward = (): void => {
    if (step >= paths.length) return;
    run++; // end a running reveal at its next checkpoint
    setStroke(step, true, !reduceMotion);
    step++;
    syncControls();
  };

  /** Hide the last drawn stroke (‹) — cancels any running auto-play. */
  const stepBackward = (): void => {
    if (step <= 0) return;
    run++;
    setStroke(step - 1, false, !reduceMotion);
    step--;
    syncControls();
  };

  prev.addEventListener("click", stepBackward);
  next.addEventListener("click", stepForward);
  replay.addEventListener("click", () => void reveal());
  syncControls();
  replay.disabled = false;
  void reveal();
}