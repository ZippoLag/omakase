/**
 * Stroke-order widget for kanji result panes: fetches the KanjiVG svg the
 * stroke_order table points at (`./strokes/<svgFile>`, cached by the service
 * worker on first fetch) and animates its strokes in order — each stroke is
 * hidden, then "drawn" by animating its stroke-dashoffset to zero, one after
 * the other. A ↻ button replays the sequence.
 *
 * Widgets are async decorations: if the svg cannot be fetched (e.g. never
 * seen offline) or holds no strokes, the figure removes itself and the pane
 * stays a normal text result.
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

/** One square animation box with a replay button, for one kanji page. */
export function strokeWidgetFigure(page: StrokePage): HTMLElement {
  const fig = document.createElement("figure");
  fig.className = "stroke-widget";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("stroke-svg");
  svg.setAttribute("viewBox", "0 0 109 109");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `stroke order of ${page.literal}`);

  const bar = document.createElement("div");
  bar.className = "stroke-bar";
  const label = document.createElement("span");
  label.className = "stroke-label";
  label.textContent = page.literal; // enriched to “食 · 9 strokes” once parsed
  const replay = document.createElement("button");
  replay.type = "button";
  replay.className = "stroke-replay";
  replay.textContent = "↻";
  replay.title = `Replay the stroke order of ${page.literal}`;
  replay.setAttribute("aria-label", replay.title);
  replay.disabled = true;
  bar.append(label, replay);

  fig.append(svg, bar);
  void loadStrokeFigure(fig, svg, page, replay, label);
  return fig;
}

async function loadStrokeFigure(
  fig: HTMLElement,
  svg: SVGElement,
  page: StrokePage,
  replay: HTMLButtonElement,
  label: HTMLSpanElement,
): Promise<void> {
  let ds: string[] | null = null;
  try {
    ds = strokePathsFrom(await fetchStrokeSvg(page.svgFile));
  } catch {
    /* stroke diagram unavailable (offline and never cached, missing file) */
  }
  if (!ds || !svg.isConnected) {
    fig.remove();
    return;
  }
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
  let run = 0;

  const reveal = async (): Promise<void> => {
    const token = ++run;
    // Reset: hide every stroke (full dash), no transition yet.
    for (const p of paths) {
      const len = Math.max(p.getTotalLength(), 1);
      p.style.transition = "none";
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
    }
    if (!svg.isConnected) return;
    for (const p of paths) {
      if (token !== run || !svg.isConnected) return; // replayed mid-way: old run stops
      const len = Math.max(p.getTotalLength(), 1);
      if (reduceMotion) {
        p.style.strokeDashoffset = "0";
        continue;
      }
      // A fairly constant drawing speed: short strokes ~0.15s, long ones up to ~0.65s.
      const dur = Math.min(650, Math.max(150, Math.round(len * 1.8)));
      p.style.transition = `stroke-dashoffset ${dur}ms linear`;
      p.style.strokeDashoffset = "0";
      await new Promise((r) => setTimeout(r, dur + 60));
    }
  };

  replay.disabled = false;
  replay.addEventListener("click", () => void reveal());
  void reveal();
}
