/**
 * Static HTTPS file server for the offline web app (dist/ is the root).
 *
 * The sqlite-wasm OPFS engine and the service worker require a *secure
 * context* with COOP/COEP headers, so this server:
 *   - always sends Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
 *   - serves TLS with a locally-trusted cert (mkcert) by default
 *
 * Phones must trust your local CA (see README "Run it on your phone") and
 * then browse to https://<your-lan-ip>:PORT. Nothing is published: the
 * server only listens on your network.
 *
 * Usage:
 *   pnpm run web:serve                     # https, port 8443, all interfaces
 *   pnpm run web:serve -- --port 9443
 *   pnpm run web:serve -- --gen-cert       # create/refresh the cert (mkcert)
 *   pnpm run web:serve -- --http --host 127.0.0.1   # dev only (no TLS)
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docroot = join(root, "dist");
const CERT_DIR = join(root, "web", ".certs");
const CERT = join(CERT_DIR, "cert.pem");
const KEY = join(CERT_DIR, "key.pem");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".db": "application/octet-stream",
};

function parseArgs(argv) {
  const args = { port: 8443, host: "0.0.0.0", http: false, genCert: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--gen-cert") args.genCert = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = argv[++i];
    else if (a === "--help") {
      console.log("usage: node scripts/serve-web.mjs [--port N] [--host H] [--http] [--gen-cert]");
      process.exit(0);
    }
  }
  return args;
}

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

function generateCert() {
  const mkcert = spawnSync("which", ["mkcert"], { encoding: "utf8" });
  if (mkcert.status !== 0) {
    console.error(
      "mkcert is not installed. Install it first, e.g. `brew install mkcert` (macOS)\n"
      + "or `choco install mkcert` (Windows), then re-run with --gen-cert.",
    );
    process.exit(1);
  }
  const install = spawnSync("mkcert", ["-install"], { stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
  const hosts = ["localhost", "127.0.0.1", ...lanAddresses()];
  const res = spawnSync(
    "mkcert",
    ["-cert-file", CERT, "-key-file", KEY, ...hosts],
    { stdio: "inherit" },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
  const ca = spawnSync("mkcert", ["-CAROOT"], { encoding: "utf8" });
  const caRoot = ca.status === 0 ? join(ca.stdout.trim(), "rootCA.pem") : "mkcert rootCA.pem";
  console.log(`\n✓ cert created for ${hosts.join(", ")}`);
  console.log(`  Trust the CA on your phone by installing: ${caRoot}\n`);
}

function sendFile(req, res, filePath) {
  const full = resolve(docroot, "." + filePath);
  if (!full.startsWith(docroot + "/") && full !== docroot) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(full) || statSync(full).isDirectory()) {
    const index = join(full, "index.html");
    if (existsSync(index) && statSync(index).isFile()) return serve(index);
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  serve(full);

  function serve(p) {
    const stat = statSync(p);
    const ext = extname(p);
    const lastModified = stat.mtime.toUTCString();
    if (req.headers["if-modified-since"] === lastModified) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Last-Modified": lastModified,
      "Cache-Control": "no-cache",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(p).pipe(res);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.genCert) {
    generateCert();
    return;
  }
  if (!existsSync(join(docroot, "kanji.db"))) {
    console.warn("⚠  dist/kanji.db missing — run `pnpm run build:db` first (or ./install.sh).");
  }
  if (!args.http && (!existsSync(CERT) || !existsSync(KEY))) {
    console.error(
      `No TLS certificate at ${CERT_DIR}. Generate one with:\n\n`
      + `  pnpm run web:gen-cert\n\n`
      + `(needs mkcert — brew install mkcert on macOS). For a no-TLS dev test on this\n`
      + `machine only, add --http (OPFS/service-worker features need a secure context\n`
      + `with COOP/COEP, so phones require the https setup).`,
    );
    process.exit(1);
  }

  const handler = (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    sendFile(req, res, normalize(path));
  };

  const server = args.http
    ? createHttpServer(handler)
    : createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, handler);

  server.listen(args.port, args.host, () => {
    const scheme = args.http ? "http" : "https";
    console.log(`omakase web app serving ${docroot}`);
    console.log(`  local:        ${scheme}://localhost:${args.port}`);
    for (const ip of lanAddresses()) {
      console.log(`  on your LAN:  ${scheme}://${ip}:${args.port}   ← open this on your phone`);
    }
    console.log("\nCOOP/COEP headers are on; service worker + OPFS enabled. Ctrl-C to stop.");
  });
}

main();
