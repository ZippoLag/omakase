/** Message protocol between the UI (main thread) and the DB worker. */

export type Command = "word" | "kanji" | "search";

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
  /** First import of the dictionary into OPFS is underway. */
  | { kind: "progress"; loadedBytes: number; totalBytes: number }
  /** Engine + dictionary are open and queries can be served. */
  | { kind: "ready"; version: string; words: number }
  /** Lookup completed: `text` renders the result; `error` (mutually
   * exclusive) carries the CLI-style "no entry" message. */
  | { kind: "result"; id: number; text: string | null; error: string | null }
  /** Fatal: engine could not start (unsupported browser / missing headers). */
  | { kind: "fatal"; message: string };
