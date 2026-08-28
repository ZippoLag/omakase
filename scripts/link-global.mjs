#!/usr/bin/env node
// Symlinks scripts/omakase-global into the pnpm global bin as `omakase`.
// Unlike `pnpm link . --global`, this only creates one symlink — it never
// reinstalls node_modules or re-links the package's dependencies.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrapper = join(root, "scripts", "omakase-global");
const globalBin = execFileSync("pnpm", ["bin", "-g"], { encoding: "utf8" }).trim();
const link = join(globalBin, "omakase");

mkdirSync(globalBin, { recursive: true });
rmSync(link, { force: true, maxRetries: 3 });
symlinkSync(wrapper, link, "file");

console.log(`linked: ${link} -> ${wrapper}`);