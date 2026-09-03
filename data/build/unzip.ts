/**
 * Minimal ZIP reader for the build pipeline — extracts files from an in-memory
 * zip (the KanjiVG release zip) with no third-party dependency. Only the
 * features the KanjiVG zip needs are implemented: stored (method 0) and
 * deflated (method 8) entries, parsed through the end-of-central-directory
 * record (so data-descriptor entries — local-header sizes of zero — still
 * extract correctly).
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD = 0x06054b50; // PK\x05\x06
const CD = 0x02014b50; // PK\x01\x02 (central directory header)
const LOCAL = 0x04034b50; // PK\x03\x04 (local file header)
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface CdRecord {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Parse the end-of-central-directory record (last 22+ bytes of the file). */
function findEocd(buf: Buffer): { entryCount: number; cdOffset: number } {
  // EOCD is the last structure; its comment may run up to 65,535 bytes.
  const tail = buf.subarray(Math.max(0, buf.length - 22 - 0xffff));
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD) continue;
    const entryCount = tail.readUInt16LE(i + 10);
    const cdOffset = tail.readUInt32LE(i + 16);
    return { entryCount, cdOffset };
  }
  throw new Error("not a zip file (no end-of-central-directory record)");
}

/** Read the central directory entries (name, method, sizes, local offset). */
function centralDirectory(buf: Buffer, entryCount: number, cdOffset: number): CdRecord[] {
  const out: CdRecord[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== CD) throw new Error(`zip central directory corrupt at offset ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Extract every file entry from `buf`. Directory entries (names ending in
 * `/`) are skipped; stored entries are returned as-is, deflated entries via
 * zlib's raw inflate.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const { entryCount, cdOffset } = findEocd(buf);
  const entries = centralDirectory(buf, entryCount, cdOffset);
  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue; // directory
    if (buf.readUInt32LE(e.localOffset) !== LOCAL) {
      throw new Error(`zip local header missing for ${e.name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compressedSize);
    if (e.method === METHOD_STORE) {
      out.push({ name: e.name, data: raw });
    } else if (e.method === METHOD_DEFLATE) {
      out.push({ name: e.name, data: inflateRawSync(raw) });
    } else {
      throw new Error(`zip entry ${e.name}: unsupported compression method ${e.method}`);
    }
  }
  return out;
}
