/**
 * Stroke-order pipeline unit tests:
 *   - readZip: minimal zip reader (stored + deflated entries) against a
 *     synthetic zip built in-memory — offline-safe, no 12 MB download needed.
 *   - loadKanjivg: entry filtering (kanji/<5-hex>.svg) + literal mapping.
 *   - src/strokes.ts: stroke parsing, path flattening, and the braille
 *     stroke-frame renderer against the real fixture SVGs (食, 水) from the
 *     pinned KanjiVG release — the frame text is pinned byte-for-byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../data/build/unzip.js";
import { loadKanjivg } from "../data/build/parse.js";
import { flattenPath, strokeFrames, strokePaths } from "../src/strokes.js";

const FIXTURES = "tests/fixtures";

function fixtureSvg(name: string): string {
  return readFileSync(join(FIXTURES, "strokes", name), "utf-8");
}

// ---- synthetic zip ----------------------------------------------------------

/** Build a tiny zip in memory (stored + deflated entries, zero crc — our
 * reader never validates checksums). */
function buildZip(files: { name: string; data: Buffer; method?: number }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const method = f.method ?? 0;
    const body = method === 8 ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc (unverified)
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16); // crc
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt32LE(0, 38); // internal attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

test("readZip: stored and deflated entries extract from an in-memory zip", () => {
  const hello = Buffer.from("hello world");
  const zip = buildZip([
    { name: "a.txt", data: hello }, // stored
    { name: "b.txt", data: Buffer.from("deflate me, please"), method: 8 }, // deflated
    { name: "dir/", data: Buffer.alloc(0) }, // directory entry — skipped
  ]);
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ["a.txt", "b.txt"],
  );
  assert.equal(entries.find((e) => e.name === "a.txt")!.data.toString("utf8"), "hello world");
  assert.equal(entries.find((e) => e.name === "b.txt")!.data.toString("utf8"), "deflate me, please");
});

test("loadKanjivg: keeps kanji/<5-hex>.svg entries and maps them to literals", () => {
  const shoku = fixtureSvg("098df.svg"); // 食, U+98DF
  const zip = buildZip([
    { name: "kanji/098df.svg", data: Buffer.from(shoku), method: 8 },
    // a symbol (U+0021 '!') — kept by the loader, dropped by the build when
    // no kanji row matches
    { name: "kanji/00021.svg", data: Buffer.from("<svg/>"), method: 8 },
    { name: "README.txt", data: Buffer.from("not a kanji file") }, // ignored
  ]);
  const entries = loadKanjivg(zip);
  assert.deepEqual(
    entries.map((e) => e.file),
    ["098df.svg", "00021.svg"],
  );
  assert.equal(entries[0]!.literal, "食");
  assert.equal(entries[1]!.literal, "!");
  assert.equal(entries[0]!.text, shoku);
});

// ---- svg parsing + flattening ----------------------------------------------

test("strokePaths: real 食 svg parses to 9 ordered strokes with kvg types", () => {
  const strokes = strokePaths(fixtureSvg("098df.svg"));
  assert.equal(strokes.length, 9);
  // stroke 1 is the roof sweep (㇒); the kvg:type attribute is carried through.
  assert.equal(strokes[0]!.type, "㇒");
  assert.ok(strokes.every((s) => s.d.startsWith("M")), "paths are absolute M curves");
});

test("flattenPath: M/L/Z and relative forms produce sampled polylines", () => {
  const open = flattenPath("M1,2 L5,2 L5,10");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.length, 3);
  assert.deepEqual(open[0]![0], { x: 1, y: 2 });
  assert.deepEqual(open[0]![2], { x: 5, y: 10 });

  // a closed subpath is a separate polyline; relative lineto resolves
  const closed = flattenPath("M0,0 h10 v10 z M20,20 l5,0");
  assert.equal(closed.length, 2);
  assert.deepEqual(closed[0]![0], { x: 0, y: 0 });
  assert.deepEqual(closed[0]![closed[0]!.length - 1], { x: 0, y: 0 }, "Z closes back to the start");
  assert.deepEqual(closed[1]![1], { x: 25, y: 20 });
});

// ---- braille frames ---------------------------------------------------------

/** Frames must be deterministic (identical input ⇒ identical output). */
function framesOf(name: string): ReturnType<typeof strokeFrames> {
  return strokeFrames(fixtureSvg(name));
}

test("strokeFrames: 水 renders 4 frames and the last one is the complete glyph", () => {
  const { strokes, frames } = framesOf("06c34.svg");
  assert.equal(strokes.length, 4);
  assert.equal(frames.length, 4);
  // Each later frame is a superset of the earlier ones (strokes accumulate).
  const onlyOn = (frame: string): Set<number> => {
    const set = new Set<number>();
    [...frame].forEach((ch, i) => {
      if (ch.codePointAt(0)! > 0x2800) set.add(i);
    });
    return set;
  };
  assert.ok(onlyOn(frames[1]!).size > onlyOn(frames[0]!).size, "frame 2 adds ink");
  assert.ok(onlyOn(frames[3]!).size > onlyOn(frames[1]!).size, "final frame adds ink");
  // All frames share the same braille grid (rows × cols stay constant).
  const grid = (f: string): string => f.split("\n").map((l) => l.length).join(",");
  assert.equal(grid(frames[0]!), grid(frames[3]!), "grid is stable across frames");
  // The completed 水 (pinned — any change here is a deliberate visual change).
  assert.equal(frames[3], [
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢴⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣦⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⠿⠃⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⢀⣤⣾⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⣶⣄⠀⠀⠀⠀⠀⣿⡇⠀⠀⢀⣠⣴⡾⠟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⣀⠀⣀⣀⣤⣴⣾⠿⠟⠋⠉⢀⣿⡇⠀⠀⠀⠀⣿⣇⣴⣾⠿⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠈⠻⠿⠟⠛⠉⠁⠀⠀⠀⠀⠀⣼⡟⠀⠀⠀⠀⠀⣿⡗⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⡿⠁⠀⠀⠀⠀⠀⣿⡇⠈⠻⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⠟⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠈⢻⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⣠⣿⠋⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠙⢿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⢀⣴⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠙⢿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⣠⡿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⣦⣄⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⢀⣴⡾⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⢷⣦⣀⠀⠀⠀⠀",
    "⠀⠐⠟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠻⣷⣦⣤⡀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠁",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⣷⣄⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⢷⣶⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  ].join("\n"));
});

test("strokeFrames: 食 renders 9 frames (pinned final frame)", () => {
  const { strokes, frames } = framesOf("098df.svg");
  assert.equal(strokes.length, 9);
  assert.equal(frames.length, 9);
  assert.equal(frames[8], [
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣾⠏⠻⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⡿⠃⠀⠀⠀⠙⠿⣦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣾⠏⠀⠀⠀⠀⠀⠀⠀⠈⠻⢷⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠟⠁⠀⠀⠀⠰⣷⡄⠀⠀⠀⠀⠀⠉⠻⣷⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⡿⠃⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠟⠋⠀⣀⣀⣀⣀⣀⣠⣤⣿⣧⣴⣶⣶⣶⣾⣶⣄⠀⠀⠀⠈⠙⢿⣦⣄⡀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⣠⣾⠟⠁⠀⠀⠘⣿⡟⠛⠛⠛⠋⠉⠉⠉⠉⠀⠀⠀⠀⣸⣿⠀⠀⠀⠀⠀⠀⠈⠛⠿⣶⣤⣄⣀⠀",
    "⠀⠀⠀⣠⣴⡿⠋⠁⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⠛⠁",
    "⢠⣶⡿⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⣿⣧⣤⣤⣤⣴⣶⣶⣶⣶⣶⣾⠿⠿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡏⠉⠉⠉⠉⠀⠀⠀⠀⠀⠀⠀⢠⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣧⣤⣤⣤⣤⣴⣶⣶⣶⣶⣶⡾⢿⣿⠀⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡏⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⠈⠋⠀⢀⣼⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⣠⣤⣀⠀⠀⠀⠀⠀⠀⣠⡾⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠈⠉⠛⢷⣦⣀⠀⢠⣾⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣷⣤⡁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣦⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⣀⣴⡦⠀⠀⠀⠀⠀⠀⠈⠻⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⣠⣾⠟⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⢿⣦⣀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⣧⣶⡿⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠻⢷⣦⣤⡀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠋⠀⠀⠀⠀",
  ].join("\n"));
});

test("strokeFrames: empty/malformed svg yields no frames rather than throwing", () => {
  assert.equal(strokeFrames("<svg></svg>").frames.length, 0);
  assert.equal(strokeFrames("not an svg").frames.length, 0);
});
