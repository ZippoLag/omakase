/**
 * DOM-free page-continuation arithmetic for the web UI (W17i ★W18f): the two
 * hard computations — folding per-section anchors into global line numbers
 * and splicing a fetched page of rows into the pane text — live here so they
 * are unit-testable without a DOM and cannot drift from the renderer's
 * line model. main.ts only reflects the results into the DOM.
 */
import type { PageAnchor } from "./worker-api.js";
import type { PageState } from "./tree.js";

/**
 * Fold per-section page anchors into GLOBAL line numbers within the
 * concatenated node text. `sectionTexts` are the raw op-section chunks in
 * render order — each already ends with a newline and carries the separator
 * before the next section, so the concatenation IS the node text with no
 * join inserted. `anchorLists` pairs each section with its anchors (line =
 * 0-based index into THAT section's `split("\n")`; the leading separator
 * newline of a chunk like `"\n" + thesaurus` counts as line 0). The global
 * line of an anchor is the number of `\n` characters in all preceding
 * sections plus its own section line — walking the sections in order and
 * accumulating newline counts reproduces the concatenation exactly.
 */
export function foldAnchors(sectionTexts: string[], anchorLists: PageAnchor[][]): PageState[] {
  const pages: PageState[] = [];
  let lineOffset = 0;
  for (let i = 0; i < sectionTexts.length; i++) {
    const text = sectionTexts[i]!;
    const anchors = anchorLists[i] ?? [];
    for (const a of anchors) {
      pages.push({ section: a.section, total: a.total, offset: a.shown, line: lineOffset + a.line });
    }
    lineOffset += countNewlines(text);
  }
  return pages;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** One splice result: the new node text, the updated pages list, and how
 * many more lines the spliced rows added than the note they replaced (later
 * anchors shift by this delta). */
export interface SpliceResult {
  text: string;
  pages: PageState[];
  delta: number;
}

/** The rendered note line format every paged renderer emits (format.ts). */
const NOTE_RE = /^  … and \d+ more$/;

/**
 * Replace a page's ``… and N more`` note line in `text` with the fetched
 * rows (plus an updated note when `remaining > 0`), advancing the page's
 * offset/line and shifting every LATER page's anchor line by the line-count
 * delta the splice introduced. `rowLines` are the new rows WITHOUT trailing
 * newlines (the caller split the worker's rowsText). The trailing-newline
 * shape of `text` is preserved: the text always ends with `\n`, so its
 * `split("\n")` carries a final "" that stays in place.
 *
 * The target page is dropped from `pages` when exhausted (remaining 0 — no
 * note, no button); its `line`/`offset` are then meaningless.
 *
 * Defensive: a stale line index (corrupt/foreign restored state) that does
 * not point at a real note line leaves the text untouched and returns the
 * pages unchanged with delta 0 — a bad state must never corrupt node.text.
 */
export function splicePage(
  text: string,
  pages: PageState[],
  pageIndex: number,
  rowLines: string[],
  remaining: number,
): SpliceResult {
  const page = pages[pageIndex];
  if (!page) return { text, pages, delta: 0 };
  const lines = text.split("\n");
  if (!NOTE_RE.test(lines[page.line] ?? "")) return { text, pages, delta: 0 };

  const before = lines.slice(0, page.line);
  const after = lines.slice(page.line + 1);
  const note = remaining > 0 ? [`  … and ${remaining} more`] : [];
  const newLines = [...before, ...rowLines, ...note, ...after];
  const delta = rowLines.length + note.length - 1; // rows + new note, minus the old note line

  const updated: PageState[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    if (i === pageIndex) {
      if (remaining > 0) {
        // offset advances by the ROWS actually shown, not the lines
        // inserted: compound/thesaurus/search rows are two lines each
        // (writing + gloss), and offset counts rows. remaining was computed
        // by the worker as total - (offset + rows shown), so the new offset
        // is total - remaining — no row-shape knowledge needed here. The
        // new note sits right after the inserted rows (which replaced the
        // old note line), so its line advances by the line count.
        updated.push({ ...p, offset: p.total - remaining, line: p.line + rowLines.length });
      }
      // exhausted: drop (no note, no button)
    } else if (p.line > page.line) {
      updated.push({ ...p, line: p.line + delta });
    } else {
      updated.push(p);
    }
  }

  return { text: newLines.join("\n"), pages: updated, delta };
}