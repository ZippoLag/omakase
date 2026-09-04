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
  /** Lookup completed: `text` renders the result; `error` (mutually
   * exclusive) carries the CLI-style "no entry" message. `strokes` (kanji
   * literal pages only) lists the stroke-order svg files behind each page,
   * so the UI can mount the per-character animation widgets. */
  | { kind: "result"; id: number; text: string | null; error: string | null; strokes?: StrokePage[] }
  /** Fatal: engine could not start (unsupported browser / missing headers). */
  | { kind: "fatal"; message: string };
