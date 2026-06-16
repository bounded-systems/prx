#!/usr/bin/env bun
/**
 * jsr-version-sync — keep each `packages/<x>/jsr.json` version in lockstep with
 * its `package.json`.
 *
 * `package.json` is the single source of truth for a package's version (it's
 * what changesets bumps on release). JSR, however, reads the version from
 * `jsr.json` at `jsr publish` time — so if the two drift, JSR publishes the
 * wrong version (or a version that was already published). This script makes
 * `jsr.json.version` a derived mirror of `package.json.version`.
 *
 * Pure-local: reads/writes files only, no network and no token (unlike
 * `jsr-sync.ts`, which syncs registry *metadata* via the JSR API).
 *
 * Usage:
 *   bun packages/prx/scripts/jsr-version-sync.ts            # --check (default): exit 1 on drift
 *   bun packages/prx/scripts/jsr-version-sync.ts --write    # rewrite drifted jsr.json versions
 *
 * The `--check` form is the CI guard (wire it into `prx ci`/docs gates); `--write`
 * is what `changeset version` should run so a release bumps both files together.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WRITE = process.argv.includes("--write");

// packages/prx/scripts → packages/
const packagesDir = join(import.meta.dir, "..", "..");

interface Drift {
  pkg: string;
  pkgVersion: string;
  jsrVersion: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collect(): Drift[] {
  const drifted: Drift[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const jsrPath = join(dir, "jsr.json");
    const pkgPath = join(dir, "package.json");
    if (!existsSync(jsrPath) || !existsSync(pkgPath)) continue;

    const pkgVersion = String(readJson(pkgPath).version ?? "");
    const jsrVersion = String(readJson(jsrPath).version ?? "");
    if (pkgVersion && pkgVersion !== jsrVersion) {
      drifted.push({ pkg: entry.name, pkgVersion, jsrVersion });
    }
  }
  return drifted;
}

/** Rewrite jsr.json's `version` in place, preserving key order and 2-space JSON. */
function writeVersion(pkg: string, version: string): void {
  const jsrPath = join(packagesDir, pkg, "jsr.json");
  const json = readJson(jsrPath);
  json.version = version;
  writeFileSync(jsrPath, `${JSON.stringify(json, null, 2)}\n`);
}

const drift = collect();

if (drift.length === 0) {
  console.log("jsr.json versions are in sync with package.json.");
  process.exit(0);
}

if (WRITE) {
  for (const d of drift) {
    writeVersion(d.pkg, d.pkgVersion);
    console.log(`synced ${d.pkg}: ${d.jsrVersion} -> ${d.pkgVersion}`);
  }
  console.log(`Done. Synced ${drift.length} jsr.json file(s).`);
  process.exit(0);
}

console.error(`jsr.json version drift (${drift.length} package(s)):`);
for (const d of drift) {
  console.error(`  ${d.pkg}: jsr.json=${d.jsrVersion} package.json=${d.pkgVersion}`);
}
console.error("Run `bun run jsr:versions` (or `jsr-version-sync.ts --write`) to fix.");
process.exit(1);
