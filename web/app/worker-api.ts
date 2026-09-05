/** Message protocol between the UI (main thread) and the DB worker. */

export type Command = "word" | "kanji" | "search";

/** One kanji page rendered by a `kanji` result that has a stroke-order svg.
 * The UI fetches `./strokes/<svgFile>` to animate it. */
export interface StrokePage {
  literal: string;
  svgFile: string;
}

/** One lookup request, tagged with the caller's id so replies can pair up. */
export interface RunRequest {
  kind: "run";
  id: number;
  command: Command;
  query: string;
  /** per-list row cap for kanji/search (the UI "max" input). */
  max: number;
}

export type WorkerRequest = RunRequest;

/**
 * Per-operation progress ladders — the divider bar's meaning while a lookup
 * runs. Each streamed section of a lookup claims its floor on arrival (the
 * UI eases toward the NEXT floor between sections so the bar keeps moving
 * during the synchronous stretches); a lookup that completes claims 100.
 * `counted` sections are driven by the worker instead: it maps real
 * done/total work onto [floor, nextFloor) and posts op-progress values the
 * UI follows verbatim (monotonic), replacing the eased creep. Search
 * `meanings` is the one counted section — profiling measured it at 1–55 s
 * in wasm for common English tokens, while every other section is ≤ ~0.5 s.
 */
export const OP_LADDERS: Record<Command, { floors: Record<string, number>; order: string[]; counted: ReadonlySet<string> }> = {
  word: {
    floors: { body: 45, thesaurus: 90, examples: 100 },
    order: ["body", "thesaurus", "examples"],
    counted: new Set(),
  },
  kanji: {
    // A kanji page is one ~250 ms block with no sub-structure (measured): a
    // single floor, eased toward ~99 until the page lands.
    floors: { page: 100, words: 100, "reading-search": 100 },
    order: ["page"],
    counted: new Set(),
  },
  search: {
    // `none` is the sole "(no results)" block: a matchless search claims 100
    // when that section streams (the result message follows immediately).
    floors: { header: 0, readings: 15, meanings: 88, kanji: 97, hint: 100, none: 100 },
    order: ["header", "readings", "meanings", "kanji", "hint"],
    counted: new Set(["meanings"]),
  },
};

/** Worker -> main thread notifications. */
export type WorkerMessage =
  | { kind: "status"; text: string }
  /** A boot milestone: the overall startup progress (0–100) the engine has
   * reached, monotonic until `ready`. The UI drives its divider progress bar
   * and the % readout from these — see worker.ts for how each stage lands on
   * the ladder (stages with no measurable sub-progress ease toward their
   * floor so the bar never freezes while one runs). */
  | { kind: "boot"; pct: number }
  /** Dictionary import into OPFS is underway. `pct` is the same overall boot
   * progress as `boot`, mapped over the import stage (byte-accurate);
   * `loadedBytes`/`totalBytes` feed the MB readout. */
  | { kind: "progress"; pct: number; loadedBytes: number; totalBytes: number }
  /** Engine + dictionary are open and queries can be served. `dict` is the
   * dictionary's own build stamp from DB meta (null for pre-versioning DBs). */
  | { kind: "ready"; version: string; words: number; dict: string | null }
  /** One rendered section of the in-flight lookup, in render order. `text`
   * is the raw chunk to append — it already carries the separator between
   * sections (a blank line for word/search, nothing for kanji pages), so
   * concatenating every section of a request reproduces the CLI text
   * byte-for-byte (see the searchSections join test). `label` names the
   * ladder floor the section claims on arrival (OP_LADDERS). */
  | { kind: "op-section"; id: number; label: string; text: string }
  /** Counted progress inside a counted ladder section (search meanings):
   * `pct` is the absolute operation progress 0–100 the section has reached,
   * monotonic — the UI follows it verbatim instead of easing. `text` is the
   * phase label for the status line. */
  | { kind: "op-progress"; id: number; pct: number; text: string }
  /** Lookup completed: a streamed success sends `text: null` (its sections
   * already rendered the pane); `error` (mutually exclusive) carries the
   * CLI-style "no entry" message; a non-null `text` is the legacy whole-
   * result path. `strokes` (kanji literal pages only) lists the stroke-order
   * svg files behind each page, so the UI can mount the per-character
   * animation widgets. */
  | { kind: "result"; id: number; text: string | null; error: string | null; strokes?: StrokePage[] }
  /** Fatal: engine could not start (unsupported browser / missing headers). */
  | { kind: "fatal"; message: string };
