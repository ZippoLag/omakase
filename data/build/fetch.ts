/**
 * Download the pinned release assets, verifying sha256, with a local cache
 * in data/raw/. Never proceeds on a checksum mismatch.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, RAW_DIR, RELEASE, SOURCE } from "./config.js";

const API = `https://api.github.com/repos/${SOURCE}/releases/tags/${encodeURIComponent(RELEASE)}`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export async function resolveAssetUrls(): Promise<Map<string, string>> {
  const res = await fetch(API, { headers: { "User-Agent": "omakase-cli-build" } });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for release ${RELEASE}: ${await res.text()}`);
  }
  const release = (await res.json()) as { assets: ReleaseAsset[] };
  const urls = new Map<string, string>();
  for (const asset of release.assets) urls.set(asset.name, asset.browser_download_url);
  return urls;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Fetch one asset by explicit URL, cached in data/raw under `name` and
 * verified against the pinned sha256 (cache hits are verified too).
 */
export async function fetchFile(name: string, url: string, sha: string, force = false): Promise<Buffer> {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, name);

  if (!force && existsSync(path)) {
    const cached = readFileSync(path);
    if (sha256(cached) === sha) {
      console.log(`  cached ${name}`);
      return cached;
    }
    console.log(`  cache mismatch for ${name}, re-downloading`);
  }

  console.log(`  downloading ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${name}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const got = sha256(buf);
  if (got !== sha) {
    throw new Error(`sha256 mismatch for ${name}: expected ${sha}, got ${got}`);
  }
  writeFileSync(path, buf);
  return buf;
}

/**
 * Returns the asset as a Buffer, reading from cache if present and valid,
 * otherwise downloading (via fetchFile) and verifying against the pinned
 * sha256. The release URL is resolved lazily — only when the cache misses,
 * since some ASSETS (e.g. the JmdictFurigana tgz) live on a different
 * release than jmdict-simplified's own assets and are cache-only after the
 * first build.
 */
export async function fetchAsset(name: string, sha: string, urls: Map<string, string>, force = false): Promise<Buffer> {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, name);
  if (!force && existsSync(path)) {
    const cached = readFileSync(path);
    if (sha256(cached) === sha) {
      console.log(`  cached ${name}`);
      return cached;
    }
    console.log(`  cache mismatch for ${name}, re-downloading`);
  }
  const url = urls.get(name);
  if (!url) throw new Error(`asset not found in release ${RELEASE}: ${name}`);
  return fetchFile(name, url, sha, force);
}

export async function fetchAll(force = false): Promise<Map<string, Buffer>> {
  const urls = await resolveAssetUrls();
  const out = new Map<string, Buffer>();
  for (const { name, sha256: sha } of ASSETS) {
    out.set(name, await fetchAsset(name, sha, urls, force));
  }
  return out;
}
