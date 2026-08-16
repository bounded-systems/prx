#!/usr/bin/env bun
/**
 * check-dep-pins — CI gate for GH-1039: every *direct* dependency in every
 * `package.json` (root + `packages/*`) must be pinned to an exact version.
 *
 * Thin wrapper: the logic lives in `../src/deps/pin-check.ts` (pure, fixture-
 * drivable) per the scripts→verbs forcing function. This file only walks the
 * workspace, loads the allowlist, prints, and sets the exit code.
 *
 *   bun run deps:pins:check              # human-readable report, exit 1 on a float
 *   bun run deps:pins:check --json       # machine-readable
 *   … --root <dir>                       # check a different workspace root
 *
 * `--root` exists so the gate can be run against a deliberately *floated*
 * fixture tree. Rule 3 binds the gate to itself: a gate's claim that it passed
 * is not evidence it would ever fail, so the test suite points this at a
 * fixture whose deps are floated and asserts a non-zero exit.
 *
 * peerDependencies and overrides/resolutions are out of scope by design — the
 * reasoning is in pin-check.ts, not repeated here.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Allowlist,
  CHECKED_FIELDS,
  checkPins,
  isFailing,
  type Manifest,
  renderReport,
  type ResolvedVersions,
} from "../src/deps/pin-check.ts";

const JSON_OUT = process.argv.includes("--json");

const rootFlag = process.argv.indexOf("--root");
// packages/prx/scripts → repo root
const repoRoot =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? (process.argv[rootFlag + 1] as string)
    : join(import.meta.dir, "..", "..", "..");
const ALLOWLIST_FILE = ".dep-pins-allowlist.json";

function readJson(abs: string): Record<string, unknown> {
  return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
}

function collectManifests(): Manifest[] {
  const out: Manifest[] = [
    { path: "package.json", json: readJson(join(repoRoot, "package.json")) },
  ];
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return out;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const rel = `packages/${entry.name}/package.json`;
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) out.push({ path: rel, json: readJson(abs) });
  }
  return out;
}

function loadAllowlist(): Allowlist {
  const abs = join(repoRoot, ALLOWLIST_FILE);
  // An absent allowlist is the goal state, not an error.
  if (!existsSync(abs)) return { entries: [] };
  const raw = readJson(abs);
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return { entries } as Allowlist;
}

/**
 * What `bun.lock` actually resolved each direct dep to.
 *
 * Two traps, both hit for real while writing this:
 *  1. The lock is JSONC — it has trailing commas, so `JSON.parse` needs them
 *     stripped first.
 *  2. An aliased dep appears under BOTH its alias key and the underlying npm
 *     name, at DIFFERENT versions (`@bounded-systems/disposition` → 0.2.0 but
 *     `@jsr/bounded-systems__disposition` → 0.3.0, a transitive). Resolution
 *     must therefore go through the alias key exactly as declared —
 *     workspace-qualified first — never the underlying package name.
 */
function loadResolved(manifests: Manifest[]): ResolvedVersions {
  const out: ResolvedVersions = new Map();
  const abs = join(repoRoot, "bun.lock");
  // No lockfile (e.g. a fixture tree) — the drift check simply does not apply.
  if (!existsSync(abs)) return out;

  let packages: Record<string, unknown>;
  try {
    const text = readFileSync(abs, "utf8").replace(/,(\s*[}\]])/g, "$1");
    packages = (JSON.parse(text) as { packages?: Record<string, unknown> }).packages ?? {};
  } catch {
    return out; // an unparseable lock is not this gate's failure to report
  }

  const versionOf = (key: string): string | undefined => {
    const entry = packages[key];
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined;
    const ident = entry[0];
    const at = ident.lastIndexOf("@");
    return at > 0 ? ident.slice(at + 1) : undefined;
  };

  for (const m of manifests) {
    // "packages/prx/package.json" → "packages/prx"; root manifest → "".
    const ws = m.path === "package.json" ? "" : m.path.replace(/\/package\.json$/, "");
    for (const field of CHECKED_FIELDS) {
      const block = m.json[field];
      if (!block || typeof block !== "object") continue;
      for (const name of Object.keys(block as Record<string, unknown>)) {
        const version = (ws ? versionOf(`${ws}/${name}`) : undefined) ?? versionOf(name);
        if (version) out.set(JSON.stringify([m.path, field, name]), version);
      }
    }
  }
  return out;
}

const manifests = collectManifests();
const report = checkPins(manifests, loadAllowlist(), loadResolved(manifests));

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderReport(report));
}

process.exit(isFailing(report) ? 1 : 0);
