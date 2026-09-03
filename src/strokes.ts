/**
 * Stroke-order rendering for the CLI: turns a KanjiVG SVG into a sequence of
 * braille (Unicode 6-dot/8-dot block) frames, one per stroke, so a terminal
 * can show the character being written stroke by stroke.
 *
 * Pure string math — no DOM, no filesystem, no dependencies — so it can run
 * in Node (CLI) or a browser if ever needed. Braille geometry: one character
 * cell covers a 2 (columns) × 4 (rows) pixel block of the SVG's coordinate
 * space, which renders at a roughly square dot pitch in a monospace terminal.
 */

/** One stroke of a kanji: its SVG path data plus its kvg stroke type (e.g.
 * '㇒'), when the SVG carries one. */
export interface Stroke {
  d: string;
  type: string | null;
}

const PATH_TAG_RE = /<path\b[^>]*>/g;
const ATTR_RE = /([A-Za-z_:]+)="([^"]*)"/g;

/** Extract the strokes of a KanjiVG svg in document (stroke) order. Every
 * `<path>` inside the `kvg:StrokePaths_*` group is one stroke; the trailing
 * `kvg:StrokeNumbers_*` group holds only `<text>` elements, so scanning path
 * tags in order is sufficient. */
export function strokePaths(svg: string): Stroke[] {
  const out: Stroke[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_TAG_RE.exec(svg))) {
    let d: string | null = null;
    let type: string | null = null;
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(m[0]))) {
      if (a[1] === "d") d = a[2] ?? null;
      else if (a[1] === "kvg:type") type = a[2] ?? null;
    }
    if (d !== null) out.push({ d, type });
  }
  return out;
}

/** One (possibly disconnected) stroke outline: a polyline of sampled points. */
type Polyline = { x: number; y: number }[];

interface Cursor {
  x: number;
  y: number;
  /** position of the last curve control point (for S/T reflection). */
  cx: number;
  cy: number;
  lastCmd: string;
}

/** Parse an SVG path `d` into flattened polylines (one per subpath). Curves
 * (C/S/Q/T) are sampled; absolute and relative forms, H/V and Z are handled.
 * KanjiVG paths use M/L/C with occasional Q/S — arcs (A) are not produced by
 * the dataset and would be a fidelity risk, so they throw. */
export function flattenPath(d: string, curveSteps = 24): Polyline[] {
  const polylines: Polyline[] = [];
  let cur: Polyline = [];
  let curPt = { x: 0, y: 0 };
  let startPt = { x: 0, y: 0 };
  let lastCtrl = { x: 0, y: 0 };
  let lastCmd = "";

  const pts = (s: string): number[] => {
    const out: number[] = [];
    const re = /-?\d*\.?\d+(?:[eE][+-]?\d+)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) out.push(Number(m[0]));
    return out;
  };

  const emit = (p: { x: number; y: number }): void => {
    cur.push({ x: p.x, y: p.y });
  };
  const close = (): void => {
    if (cur.length > 1) polylines.push(cur);
    cur = [];
  };

  // Split the d string into (command letter, argument text) tokens. Spaces
  // between commands are skipped (a no-argument command like Z leaves them
  // in the buffer).
  const tokens: { cmd: string; args: string }[] = [];
  let rest = d.trim();
  const cmdRe = /[AaCcHhLlMmQqSsTtVvZz]/;
  while (rest.length > 0) {
    rest = rest.trimStart();
    const c = rest[0]!;
    if (!cmdRe.test(c)) throw new Error(`stroke path data: unexpected '${c}'`);
    rest = rest.slice(1);
    if (c === "Z" || c === "z") {
      tokens.push({ cmd: c, args: "" });
    } else {
      const m = cmdRe.exec(rest);
      const args = m ? rest.slice(0, m.index) : rest;
      rest = m ? rest.slice(m.index) : "";
      tokens.push({ cmd: c, args });
    }
  }

  for (const tok of tokens) {
    const cmd = tok.cmd;
    const nums = pts(tok.args);
    let i = 0;
    const read = (): { x: number; y: number } => {
      const x = nums[i++]!;
      const y = nums[i++]!;
      return { x, y };
    };
    const rel = cmd === cmd.toLowerCase();
    const abs = (p: { x: number; y: number }): { x: number; y: number } =>
      rel ? { x: curPt.x + p.x, y: curPt.y + p.y } : p;
    const reflect = (): { x: number; y: number } =>
      cmd === "s" || cmd === "S" || cmd === "t" || cmd === "T"
        ? { x: 2 * curPt.x - lastCtrl.x, y: 2 * curPt.y - lastCtrl.y }
        : { x: curPt.x, y: curPt.y };

    switch (cmd.toUpperCase()) {
      case "M": {
        close();
        while (i < nums.length) {
          const p = abs(read());
          if (cur.length === 0) startPt = p;
          emit(p);
          curPt = p;
          lastCmd = cmd;
          if (i < nums.length) lastCmd = "l"; // implicit lineto continues a moveto
        }
        break;
      }
      case "L": {
        while (i < nums.length) {
          const p = abs(read());
          emit(p);
          curPt = p;
        }
        lastCmd = cmd;
        break;
      }
      case "H": {
        while (i < nums.length) {
          const x = rel ? curPt.x + nums[i++]! : nums[i++]!;
          const p = { x, y: curPt.y };
          emit(p);
          curPt = p;
        }
        lastCmd = cmd;
        break;
      }
      case "V": {
        while (i < nums.length) {
          const y = rel ? curPt.y + nums[i++]! : nums[i++]!;
          const p = { x: curPt.x, y };
          emit(p);
          curPt = p;
        }
        lastCmd = cmd;
        break;
      }
      case "C": {
        while (i < nums.length) {
          const c1 = abs(read());
          const c2 = abs(read());
          const p = abs(read());
          const base = cur.length > 0 ? cur[cur.length - 1]! : { x: 0, y: 0 };
          const seg: Polyline = [];
          for (let k = 0; k <= curveSteps; k++) {
            const t = k / curveSteps;
            const u = 1 - t;
            seg.push({
              x: u * u * u * base.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x,
              y: u * u * u * base.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y,
            });
          }
          cur.push(...seg.slice(1));
          curPt = p;
          lastCtrl = c2;
        }
        lastCmd = cmd;
        break;
      }
      case "S": {
        while (i < nums.length) {
          const c2 = abs(read());
          const p = abs(read());
          const c1 = reflect();
          const base = cur.length > 0 ? cur[cur.length - 1]! : { x: 0, y: 0 };
          const seg: Polyline = [];
          for (let k = 0; k <= curveSteps; k++) {
            const t = k / curveSteps;
            const u = 1 - t;
            seg.push({
              x: u * u * u * base.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x,
              y: u * u * u * base.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y,
            });
          }
          cur.push(...seg.slice(1));
          curPt = p;
          lastCtrl = c2;
        }
        lastCmd = cmd;
        break;
      }
      case "Q": {
        while (i < nums.length) {
          const c = abs(read());
          const p = abs(read());
          const base = cur.length > 0 ? cur[cur.length - 1]! : { x: 0, y: 0 };
          const seg: Polyline = [];
          for (let k = 0; k <= curveSteps; k++) {
            const t = k / curveSteps;
            const u = 1 - t;
            seg.push({
              x: u * u * base.x + 2 * u * t * c.x + t * t * p.x,
              y: u * u * base.y + 2 * u * t * c.y + t * t * p.y,
            });
          }
          cur.push(...seg.slice(1));
          curPt = p;
          lastCtrl = c;
        }
        lastCmd = cmd;
        break;
      }
      case "T": {
        while (i < nums.length) {
          const p = abs(read());
          const c = reflect();
          const base = cur.length > 0 ? cur[cur.length - 1]! : { x: 0, y: 0 };
          const seg: Polyline = [];
          for (let k = 0; k <= curveSteps; k++) {
            const t = k / curveSteps;
            const u = 1 - t;
            seg.push({
              x: u * u * base.x + 2 * u * t * c.x + t * t * p.x,
              y: u * u * base.y + 2 * u * t * c.y + t * t * p.y,
            });
          }
          cur.push(...seg.slice(1));
          curPt = p;
          lastCtrl = c;
        }
        lastCmd = cmd;
        break;
      }
      case "Z": {
        if (cur.length > 0 && curPt !== startPt) {
          emit(startPt);
          curPt = startPt;
        }
        close();
        lastCmd = cmd;
        break;
      }
      default:
        throw new Error(`stroke path data: unsupported command '${tok.cmd}'`);
    }
  }
  close();
  return polylines;
}

export interface StrokeFrameOptions {
  /** pixels the pen covers around the centerline (SVG units). Default 1.2:
   * the kanjiVG strokes are 3 SVG units wide, and braille has no
   * antialiasing, so a slightly thinner pen keeps diagonals legible. */
  pen?: number;
}

export interface StrokeFrames {
  strokes: Stroke[];
  /** one braille text frame per stroke (newline-joined rows). Frame k shows
   * strokes 1..k+1, so the last frame is the completed character. */
  frames: string[];
}

/**
 * Rasterize a KanjiVG svg into stroke-by-stroke braille frames. The union
 * bounding box of every stroke is trimmed to content (with a 2 px margin),
 * and every frame shares the same grid so successive strokes stay aligned.
 */
export function strokeFrames(svg: string, opts: StrokeFrameOptions = {}): StrokeFrames {
  const pen = opts.pen ?? 1.2;
  const strokes = strokePaths(svg);
  const polylines = strokes.map((s) => flattenPath(s.d));

  // Union bounding box over all strokes (in SVG units).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pl of polylines) {
    for (const p of pl.flat()) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { strokes, frames: [] };

  const pad = 2;
  const left = Math.floor(minX - pad);
  const top = Math.floor(minY - pad);
  const w = Math.ceil(maxX + pad) - left; // svg-unit width of the raster
  const h = Math.ceil(maxY + pad) - top;

  /** Sample a polyline at ~pen/2 spacing into the pixel grid. */
  const paint = (grid: Uint8Array, pl: Polyline[]): void => {
    const stamp = (x: number, y: number): void => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > pen) continue;
          const px = Math.floor(x - left + dx);
          const py = Math.floor(y - top + dy);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          grid[py * w + px] = 1;
        }
      }
    };
    for (const poly of pl) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[i + 1]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.ceil(len / (pen / 2)));
        for (let k = 0; k <= n; k++) {
          stamp(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
        }
      }
    }
  };

  const cols = Math.ceil(w / 2);
  const rows = Math.ceil(h / 4);

  const frameOf = (grid: Uint8Array): string => {
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        const px = (dx: number, dy: number, dot: number): void => {
          const x = c * 2 + dx;
          const y = r * 4 + dy;
          if (x < w && y < h && grid[y * w + x]) bits |= dot;
        };
        px(0, 0, 0x01); // dot 1
        px(0, 1, 0x02); // dot 2
        px(0, 2, 0x04); // dot 3
        px(1, 0, 0x08); // dot 4
        px(1, 1, 0x10); // dot 5
        px(1, 2, 0x20); // dot 6
        px(0, 3, 0x40); // dot 7
        px(1, 3, 0x80); // dot 8
        line += String.fromCodePoint(0x2800 + bits);
      }
      lines.push(line);
    }
    return lines.join("\n");
  };

  const grid = new Uint8Array(w * h);
  const frames: string[] = [];
  for (const pl of polylines) {
    paint(grid, pl);
    frames.push(frameOf(grid));
  }
  return { strokes, frames };
}
