/**
 * Deploy the web app to Cloudflare Pages + R2 — the free, permanent host
 * (see README "Publish it online for free" for the one-time manual setup).
 *
 * Flow:
 *   1. (optional --build) run the web build so dist/ is fresh
 *   2. upload dist/kanji.db to the R2 bucket (wrangler.toml: [[r2_buckets]])
 *   3. move dist/kanji.db aside and `wrangler pages deploy` the rest of
 *      dist/ (the shell + strokes/), restoring kanji.db afterwards
 *
 * The dictionary must NOT be uploaded to Pages itself — its 25 MiB per-asset
 * limit rejects the ~341 MB file — so it is streamed to the app through the
 * Pages Function at functions/kanji.db.ts, which reads the same R2 object.
 * Both halves come from the same dist/ build, so the served dist/meta.json
 * stamp and the dictionary in R2 always match (the worker re-imports exactly
 * when a new build ships a new stamp).
 *
 * wrangler.toml is the single source of truth: the project name, the build
 * output directory, and the R2 binding + bucket are read from it here.
 *
 * Auth (one time): `pnpm exec wrangler login` — or, for CI, set
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID instead.
 *
 * Usage:
 *   pnpm run deploy:web                # deploy the existing dist/
 *   pnpm run deploy:web -- --build     # web:build first, then deploy
 *   pnpm run deploy:web -- --branch <name>   # deploy to a preview branch
 *   node scripts/deploy-web.mjs --help
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { versionFromStamp } from "./sw-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TMP_DIR = join(root, ".deploy-tmp"); // kanji.db park-out during the Pages upload
const DB_KEY = "kanji.db";

function fail(message) {
  console.error(`\n✘ ${message}`);
  process.exit(1);
}

function log(step) {
  console.log(`\n→ ${step}`);
}

/** Read a top-level `key = "value"` string from wrangler.toml. */
function tomlValue(toml, key) {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

function parseArgs(argv) {
  const args = { build: false, branch: "main", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build") args.build = true;
    else if (a === "--branch") args.branch = argv[++i];
    else if (a === "--help") args.help = true;
    else {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function run(args, { die = true } = {}) {
  const res = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (res.status !== 0 && die) {
    fail(`\`wrangler ${args.join(" ")}\` failed (exit ${res.status ?? "signal"}).`);
  }
  return res.status ?? 1;
}

/** The R2 account id (endpoint host): env override, else `wrangler whoami`. */
function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const who = runCapture(["whoami"]);
  if (who.status === 0) {
    const m = who.out.match(/[0-9a-f]{32}/);
    if (m) return m[0];
  }
  return null;
}

/**
 * The R2 credentials this script needs, filled from the project's gitignored
 * env files (`.env`, then `.dev.vars`) when they aren't already exported.
 * Both files are already the repo's home for local credentials (wrangler reads
 * them too), so the release needs no extra shell setup — real environment
 * variables always win, and only these three keys are read. Returns the file
 * that supplied them, or null when nothing was loaded.
 */
function loadLocalCredentials() {
  const wanted = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID"];
  if (wanted.every((k) => process.env[k])) return null;
  for (const file of [".env", ".dev.vars"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || !wanted.includes(m[1])) continue;
      let value = m[2];
      if (value.length >= 2 && (value.startsWith("\"") || value.startsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]] && value) process.env[m[1]] = value;
    }
    if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) return file;
  }
  return null;
}

/**
 * Upload dist/kanji.db to the R2 bucket through the S3-compatible API
 * (multipart). wrangler's `r2 object put` caps files at 300 MiB and this one
 * is well past that, so the object can't go through wrangler; the S3 API has
 * no such limit and R2's multipart upload handles the size fine.
 *
 * Requires R2 API credentials (separate from the wrangler login):
 * dash.cloudflare.com → R2 → Manage R2 API Tokens → Create API Token
 * (Object Read & Write, bucket-scoped), as
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * — exported, or written to the gitignored `.env` / `.dev.vars` (this script
 * picks them up from there). CLOUDFLARE_ACCOUNT_ID is optional: it falls back
 * to reading the account id from `wrangler whoami`.
 */
async function uploadDbToR2({ bucket, dbPath }) {
  const fromFile = loadLocalCredentials();
  if (fromFile) console.log(`  (using the R2 credentials in ${fromFile})`);
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const sizeMiB = (statSync(dbPath).size / 1048576).toFixed(0);
  if (!accessKeyId || !secretAccessKey) {
    fail(
      `the dictionary (${sizeMiB} MiB) exceeds wrangler's 300 MiB r2 object put limit, `
      + "so the upload needs R2 API credentials. Create an API token:\n"
      + "  dash.cloudflare.com → R2 → Manage R2 API Tokens → Create API Token\n"
      + "  (Object Read & Write, bucket: " + bucket + "), then put them in the\n"
      + "  gitignored .env (or .dev.vars) — or export them:\n"
      + "  R2_ACCESS_KEY_ID=<access key id>\n"
      + "  R2_SECRET_ACCESS_KEY=<secret access key>\n"
      + "and re-run.",
    );
  }
  const id = accountId();
  if (!id) fail("could not determine the Cloudflare account id (set CLOUDFLARE_ACCOUNT_ID).");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${id}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: DB_KEY,
      Body: createReadStream(dbPath),
      ContentType: "application/octet-stream",
    },
    partSize: 16 * 1024 * 1024,
    queueSize: 4,
  });
  upload.on("httpUploadProgress", (e) => {
    if (e.total) {
      const pct = Math.round(((e.loaded ?? 0) / e.total) * 100);
      console.log(`  uploaded ${pct}% (${(e.loaded / 1048576).toFixed(0)}/${(e.total / 1048576).toFixed(0)} MB)`);
    }
  });
  try {
    await upload.done();
  } catch (err) {
    fail(`R2 upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Capture-mode run: returns stdout. */
function runCapture(args) {
  const res = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: res.status ?? 1, out: res.stdout ?? "" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/deploy-web.mjs [--build] [--branch <name>]\n"
      + "\n"
      + "  --build        run the web build (pnpm run web:build) first\n"
      + "  --branch <n>   Pages branch to deploy to (default: main — production)\n"
      + "\n"
      + "One-time manual setup (see README \"Publish it online for free\"):\n"
      + "  pnpm exec wrangler login\n"
      + "  pnpm install\n"
      + "(deploy:web creates the R2 bucket and Pages project if missing)\n",
    );
    return;
  }

  // wrangler.toml is the source of truth for name / output dir / bucket.
  const tomlPath = join(root, "wrangler.toml");
  if (!existsSync(tomlPath)) fail(`missing ${tomlPath} — cannot deploy.`);
  const toml = readFileSync(tomlPath, "utf8");
  const project = tomlValue(toml, "name");
  const outDir = tomlValue(toml, "pages_build_output_dir");
  const bucket = tomlValue(toml, "bucket_name");
  if (!project) fail("wrangler.toml is missing `name = \"...\"`.");
  if (!outDir) fail("wrangler.toml is missing `pages_build_output_dir = \"...\"`.");
  if (!bucket) fail("wrangler.toml is missing `[[r2_buckets]]` with `bucket_name = \"...\"`.");
  const dist = join(root, outDir);

  // Heal an interrupted previous deploy (kanji.db parked but not restored).
  const parked = join(TMP_DIR, DB_KEY);
  const dbPath = join(dist, DB_KEY);
  if (existsSync(parked) && !existsSync(dbPath)) {
    console.log("→ restoring dist/kanji.db left over from an interrupted deploy…");
    renameSync(parked, dbPath);
  }

  if (args.build) {
    log(`running the web build (${outDir}/)…`);
    const res = spawnSync(process.execPath, [join(root, "scripts", "build-web.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    if (res.status !== 0) fail("web build failed.");
  }

  for (const required of [dist, dbPath, join(dist, "meta.json")]) {
    if (!existsSync(required)) {
      fail(`${required} missing — run \`pnpm run web:build\` (and \`pnpm run build:db\` for the dictionary) first.`);
    }
  }

  // Wrangled tooling present + authenticated?
  const wr = runCapture(["--version"]);
  if (wr.status !== 0) fail("wrangler is not installed — run `pnpm install`.");
  const whoami = runCapture(["whoami"]);
  if (whoami.status !== 0) {
    fail("not logged in to Cloudflare — run `pnpm exec wrangler login` first.");
  }

  let version = "unknown";
  let schemaVersion = "unknown";
  try {
    const meta = JSON.parse(readFileSync(join(dist, "meta.json"), "utf8"));
    if (typeof meta.version === "string") version = meta.version;
    if (meta.schemaVersion != null) schemaVersion = String(meta.schemaVersion);
  } catch { /* warn below */ }
  // The shell carries its own stamp (dist/src/version.js, written by
  // web:build) — a different number from the dictionary's, by design. Print
  // both: shipping a stale shell is the easiest release mistake, and since the
  // worker re-imports on the *dictionary* stamp alone, nothing else would
  // reveal it. A dictionary schema newer than the app's is refused at boot.
  let shellVersion = "unknown";
  try {
    shellVersion = versionFromStamp(readFileSync(join(dist, "src", "version.js"), "utf8")) ?? "unknown";
  } catch { /* warn below */ }
  const dbMb = (statSync(dbPath).size / 1048576).toFixed(0);

  console.log(`\nDeploying omakase to Cloudflare (project: ${project}, bucket: ${bucket}):`);
  console.log(`  dictionary build: ${version} (schema ${schemaVersion})`);
  console.log(`  shell build:      ${shellVersion}`);
  console.log(`  dist/kanji.db: ${dbMb} MB → r2://${bucket}/${DB_KEY}`);
  console.log(`  ${outDir}/ (minus kanji.db) → Pages (branch: ${args.branch})`);

  // Bucket must exist before the object upload; create it on first deploy.
  const buckets = runCapture(["r2", "bucket", "list"]);
  if (buckets.status !== 0) fail("`wrangler r2 bucket list` failed — check your login / API token.");
  if (!buckets.out.includes(bucket)) {
    log(`creating R2 bucket "${bucket}"…`);
    const created = runCapture(["r2", "bucket", "create", bucket]);
    if (created.status !== 0) {
      fail(
        `bucket "${bucket}" is missing and could not be created. Create it with:\n`
        + `  pnpm exec wrangler r2 bucket create ${bucket}\n`
        + `(or edit bucket_name in wrangler.toml).`,
      );
    }
  }

  // The Pages project must exist before the first deploy; create it (mirrors
  // the bucket ensure above). Production branch: main (matches the default
  // `--branch` passed to `wrangler pages deploy` below).
  const projects = runCapture(["pages", "project", "list"]);
  if (projects.status !== 0) fail("`wrangler pages project list` failed — check your login / API token.");
  if (!projects.out.includes(project)) {
    log(`creating Pages project "${project}"…`);
    const created = runCapture(["pages", "project", "create", project, "--production-branch", "main"]);
    if (created.status !== 0) {
      fail(
        `Pages project "${project}" is missing and could not be created. Create it with:\n`
        + `  pnpm exec wrangler pages project create ${project} --production-branch main\n`
        + `(or edit name in wrangler.toml).`,
      );
    }
  }

  log(`uploading dist/kanji.db to r2://${bucket}/${DB_KEY}…`);
  await uploadDbToR2({ bucket, dbPath });

  // Pages rejects files over 25 MiB — park the dictionary for the shell
  // upload and restore it afterwards, whatever happens.
  log(`deploying ${outDir}/ to Pages…`);
  mkdirSync(TMP_DIR, { recursive: true });
  renameSync(dbPath, parked);
  try {
    run(["pages", "deploy", "--branch", args.branch]);
  } finally {
    renameSync(parked, dbPath);
  }

  // The pages.dev subdomain can carry a suffix when the plain name is taken
  // globally (this account's earlier project "omakase" landed at
  // omakase-cub.pages.dev for exactly that reason) — read the real domain from
  // the project so the printed URL is exact.
  const after = runCapture(["pages", "project", "list"]);
  let domain = `${project}.pages.dev`;
  if (after.status === 0) {
    const row = after.out.match(new RegExp(`│\\s*${project}\\s+│\\s*([^│\\s]+)\\s*│`));
    if (row?.[1]) domain = row[1];
  }

  console.log(`\n✓ Deployed. Open https://${domain} on a phone:`);
  console.log("  the first visit downloads the dictionary into OPFS (one time, ~341 MB).");
  console.log("  Re-deploy any time with `pnpm run deploy:web` — the shell and the");
  console.log("  dictionary come from the same build, so updates re-import automatically.");
}

await main();