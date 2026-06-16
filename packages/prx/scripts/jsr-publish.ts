#!/usr/bin/env bun
/**
 * jsr-publish — publish every @bounded-systems/* package whose current version
 * is not yet on JSR, in dependency order. The automated release leg: run on
 * push to main (release.yml) after the "Version Packages" PR bumps versions.
 *
 * Idempotent, like `changeset publish`: each package's version is checked
 * against the JSR registry (api.jsr.io); already-published versions are skipped,
 * so a run with nothing new to publish is a no-op. Packages publish in
 * topological order (a dependency is published before its dependents) so an
 * intra-scope `jsr:` reference always resolves to an already-published version.
 *
 * Auth: tokenless OIDC in GitHub Actions (`id-token: write`) — the `jsr` CLI
 * detects the Actions runtime and exchanges the OIDC token for publish rights.
 * Each package must already exist + be linked to its repo on JSR (jsr-sync).
 *
 * Slow types: defaults to `--allow-slow-types` so a release is not blocked by a
 * package that has not yet annotated its public API. Pass `--strict` to require
 * fast types (publish fails on slow types instead).
 *
 * Usage:
 *   bun packages/prx/scripts/jsr-publish.ts [--dry-run] [--strict]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSR_PACKAGES } from "./jsr-manifest.generated.ts";

const DRY = process.argv.includes("--dry-run");
const STRICT = process.argv.includes("--strict");

// Packages cleared for auto-publish. Each has a clean `jsr publish` — no
// unsupported import attributes (e.g. `with { type: "text" }`), and every
// intra-scope dependency is itself published to JSR. A package NOT in this set
// is held (skipped, not failed) so a release stays green; add it here once
// `jsr publish` succeeds for it. The remaining @bounded-systems/* packages have
// real JSR-compat blockers tracked separately. `--all` overrides the gate (e.g.
// to re-discover which packages now pass).
export const READY = new Set<string>([
  "anchored-chain",
  "audit-context",
  "auth",
  "cas",
  "env",
  "host",
  "scout",
]);
const ALL = process.argv.includes("--all");

const API = "https://api.jsr.io";
// packages/prx/scripts → packages/
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Pkg {
  name: string;
  pkg: string;
  scope: string;
  dir: string;
  version: string;
  deps: string[]; // intra-scope dependency pkg names (within the manifest)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Load each manifest package with its jsr.json version and intra-scope deps. */
export function load(): Pkg[] {
  const inManifest = new Set(JSR_PACKAGES.map((p) => p.pkg));
  return JSR_PACKAGES.map((p) => {
    const dir = join(packagesDir, p.pkg);
    const jsr = readJson(join(dir, "jsr.json"));
    const pj = readJson(join(dir, "package.json"));
    const version = jsr.version as string | undefined;
    if (!version) throw new Error(`${p.pkg}: jsr.json has no version (run \`bun run jsr:versions\`)`);
    const declared = {
      ...((pj.dependencies as Record<string, string>) ?? {}),
      ...((pj.peerDependencies as Record<string, string>) ?? {}),
    };
    const deps = Object.keys(declared)
      .filter((d) => d.startsWith(`@${p.scope}/`))
      .map((d) => d.slice(p.scope.length + 2))
      .filter((d) => inManifest.has(d));
    return { name: p.name, pkg: p.pkg, scope: p.scope, dir, version, deps };
  });
}

/** Topological order: a package's dependencies come before it (DFS post-order). */
export function topo(pkgs: Pkg[]): Pkg[] {
  const byName = new Map(pkgs.map((p) => [p.pkg, p]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 visiting, 2 done
  const out: Pkg[] = [];
  const visit = (name: string): void => {
    const s = state.get(name) ?? 0;
    if (s !== 0) return; // done, or a cycle we break by ignoring the back-edge
    state.set(name, 1);
    const p = byName.get(name);
    if (p) for (const d of p.deps) visit(d);
    state.set(name, 2);
    if (p) out.push(p);
  };
  for (const p of pkgs) visit(p.pkg);
  return out;
}

/**
 * Versions already on JSR for a package. The request URL is built only from the
 * manifest constants (scope/pkg) — the package's own version (a file read) is
 * NOT put in the request, so there is no file-data → HTTP dataflow (cf. #655,
 * which moved jsr-sync off readFileSync→fetch to clear a CodeQL alert). The
 * caller checks membership against the returned set instead.
 */
async function publishedVersions(scope: string, pkg: string): Promise<Set<string>> {
  // NB: no `?limit=` — that query param makes this endpoint return an empty
  // page ({items:[],total:0}). The default page lists the (few) versions, newest
  // first, which covers our release cadence; revisit if a package ever carries
  // more versions than one page.
  const res = await fetch(`${API}/scopes/${scope}/packages/${pkg}/versions`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return new Set(); // package not reserved yet → nothing published
  if (res.status !== 200) {
    throw new Error(`JSR versions list for @${scope}/${pkg} → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { items?: { version: string }[] };
  return new Set((body.items ?? []).map((v) => v.version));
}

function publish(p: Pkg): boolean {
  const args = ["jsr", "publish", ...(STRICT ? [] : ["--allow-slow-types"])];
  const r = spawnSync("bunx", args, { cwd: p.dir, stdio: "inherit" });
  return r.status === 0;
}

/** Run the publish pass (gate → dedup → publish). Returns the failed tags. */
async function run(): Promise<string[]> {
  const ordered = topo(load());
  console.log(
    `${DRY ? "[dry-run] " : ""}JSR publish — ${ordered.length} package(s) in dependency order:`,
  );

  let published = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const p of ordered) {
    const tag = `${p.name}@${p.version}`;
    if (!ALL && !READY.has(p.pkg)) {
      console.log(`- hold    ${tag} (not yet cleared for JSR auto-publish)`);
      skipped++;
      continue;
    }
    if ((await publishedVersions(p.scope, p.pkg)).has(p.version)) {
      console.log(`- skip    ${tag} (already on JSR)`);
      skipped++;
      continue;
    }
    if (DRY) {
      console.log(`- would publish ${tag}`);
      published++;
      continue;
    }
    console.log(`- publish ${tag} …`);
    if (publish(p)) {
      console.log(`  ✓ ${tag}`);
      published++;
    } else {
      console.error(`  ✗ ${tag} — publish failed`);
      failed.push(tag);
    }
  }

  console.log(
    `Done. ${published} published${DRY ? " (dry-run)" : ""}, ${skipped} skipped, ${failed.length} failed.`,
  );
  return failed;
}

// Only run when invoked directly; importers (e.g. the status-doc generator) get
// the exports (READY/load/topo) without triggering a publish pass.
if (import.meta.main) {
  const failed = await run();
  if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}
