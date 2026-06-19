// GH-2401 (po05a.1) — coverage test for the source→domain map.
//
// The spike's Verification §1 (docs/spikes/GH-2400-cas-domain-pinned-to-source.md):
// "every CAS-writing call site (the §3 producer table) maps to exactly one
// source domain (no orphans)." This test is that guard. It statically discovers
// every module under `src/` that obtains and uses a CAS write primitive
// (`writeBlob` / `putArtifact` / `setRef`) and asserts the discovered set equals
// the kernel modules + the declared producer table — bidirectionally, so a new
// undeclared call site OR a stale declaration both fail.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  CAS_DOMAINS,
  CAS_PRIMITIVE_MODULES,
  CAS_PRODUCERS,
  DYNAMIC_DOMAIN,
  SYNC_MIRROR_DOMAINS,
  isDeclaredCasWriter,
  producerForCallSite,
} from "../../src/plan-store/source-domain.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** The CAS write primitives — the capabilities a producer must obtain to write. */
const WRITE_PRIMITIVES = ["writeBlob", "putArtifact", "setRef"] as const;

/**
 * The map module itself names the primitives only documentarily (doc comments,
 * the producer table). It is the registry, not a CAS writer — exempt from the
 * scan so its prose doesn't read as an orphan call site.
 */
const SCAN_EXEMPT = new Set<string>(["src/plan-store/source-domain.ts"]);

/** Repo-root-relative POSIX path (stable across platforms). */
function toPosixRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

/** Recursively list `*.ts` source files under `src/`, excluding tests. */
function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...listSrcFiles(abs));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    out.push(abs);
  }
  return out;
}

/**
 * Does this file IMPORT a CAS write primitive from the plan-store CAS modules
 * (`cas.ts` / `artifact-store.ts`)? Alias-aware (`writeBlob as defaultWriteBlob`).
 * Importing a write primitive is the authoritative signal that a module can
 * write to the CAS — robust against call-site aliasing (`setRefFn(...)`).
 */
function importsWritePrimitive(content: string): boolean {
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  for (const m of content.matchAll(importRe)) {
    const [, names, modPath] = m;
    if (!modPath || !/(?:^|\/)(?:cas|artifact-store)\.ts$/.test(modPath)) continue;
    for (const raw of (names ?? "").split(",")) {
      const imported = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if ((WRITE_PRIMITIVES as readonly string[]).includes(imported ?? "")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Does this file CALL a CAS write primitive — a bareword `writeBlob(` /
 * `putArtifact(` / `setRef(` or a method form `.writeBlob(` (the injected
 * `opts.cas.writeBlob(...)` seam)? Catches a producer that receives a CAS dep
 * without importing the primitive by name. Function-definition lines live only
 * in the kernel modules (which are exempt), so they never cause a false fail.
 */
function callsWritePrimitive(content: string): boolean {
  const callRe = /(?:^|[^.\w$])(?:writeBlob|putArtifact|setRef)\s*\(/m;
  const methodRe = /\.(?:writeBlob|putArtifact|setRef)\s*\(/;
  return callRe.test(content) || methodRe.test(content);
}

describe("source→domain map coverage (GH-2401, spike §1 verification)", () => {
  const srcFiles = listSrcFiles(SRC_ROOT);

  // The statically-discovered set of CAS-writing call sites in src/.
  const discovered = new Set<string>();
  for (const abs of srcFiles) {
    const rel = toPosixRel(abs);
    if (SCAN_EXEMPT.has(rel)) continue;
    const content = readFileSync(abs, "utf8");
    if (importsWritePrimitive(content) || callsWritePrimitive(content)) {
      discovered.add(rel);
    }
  }

  test("discovers the expected CAS-writing modules (kernel + producers)", () => {
    // Sanity floor: if the scan finds nothing, the detectors are broken.
    expect(discovered.size).toBeGreaterThanOrEqual(
      CAS_PRODUCERS.length + CAS_PRIMITIVE_MODULES.length,
    );
  });

  test("every discovered CAS-writing call site is declared (no orphans)", () => {
    const orphans = [...discovered].filter((f) => !isDeclaredCasWriter(f)).sort();
    expect(orphans).toEqual([]);
  });

  test("every declared producer call site actually writes to the CAS (no stale entries)", () => {
    const stale = CAS_PRODUCERS.map((p) => p.callSite).filter((f) => !discovered.has(f));
    expect(stale).toEqual([]);
  });

  test("every kernel module is present in src (no stale kernel entry)", () => {
    const missing = CAS_PRIMITIVE_MODULES.filter((f) => !discovered.has(f));
    expect(missing).toEqual([]);
  });

  test("each producer maps to exactly one call site (no duplicate declarations)", () => {
    const seen = new Map<string, number>();
    for (const p of CAS_PRODUCERS) {
      seen.set(p.callSite, (seen.get(p.callSite) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([f]) => f);
    expect(dupes).toEqual([]);
  });

  test("every producer domain is a known CAS prefix or dynamic", () => {
    const valid = new Set<string>([...CAS_DOMAINS, DYNAMIC_DOMAIN]);
    const bad = CAS_PRODUCERS.filter((p) => !valid.has(p.domain)).map(
      (p) => `${p.source}→${p.domain}`,
    );
    expect(bad).toEqual([]);
  });

  test("no producer writes a sync/mirror domain as a CAS prefix (spike §3)", () => {
    const mirror = new Set<string>(SYNC_MIRROR_DOMAINS);
    const leaked = CAS_PRODUCERS.filter((p) => mirror.has(p.domain)).map((p) => p.source);
    expect(leaked).toEqual([]);
  });

  test("every declared CAS prefix has at least one producer (no orphan domains)", () => {
    const written = new Set(CAS_PRODUCERS.map((p) => p.domain));
    const unproduced = CAS_DOMAINS.filter((d) => !written.has(d));
    expect(unproduced).toEqual([]);
  });

  test("producerForCallSite resolves each declared producer", () => {
    for (const p of CAS_PRODUCERS) {
      expect(producerForCallSite(p.callSite)?.source).toBe(p.source);
    }
  });
});
