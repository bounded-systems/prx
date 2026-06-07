// GH-296 / prx-fda — the daemon-backed default reader for the aggregate bead
// load. `loadAllBeads` (and the per-invocation BeadsCache over it) historically
// spawned the host `bd list` against the per-clone `.beads` — the broken store
// GH-296 is retiring. This routes that aggregate read through the daemon instead.
//
// Why a subprocess and not `loadAllBeadsViaDaemon` directly: the daemon door is
// async, but `loadAllBeads`/`BeadsCache.load()` are SYNCHRONOUS and called deep
// inside sync verb code (adapters, drift-fix loops). Making them async would
// ripple through ~24 call sites. `prx beads list --all --limit 0` runs that same
// daemon query (see beadsd/reads.ts loadAllBeadsViaDaemon → {kind:"list",
// all:true, limit:0}) in its own process and prints the RAW snake_case array, so
// a single sync spawn + the existing parseBeadsRecords transform keeps the sync
// signature with no async ripple.
//
// Recursion-safe: `prx beads list` reads via withBeadsClient (the socket door),
// NOT via this cache/loader — so the spawn cannot re-enter here.

import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";

import { parseBeadsRecords, type BeadsRecord } from "./triage.ts";

export type LoadAllBeadsViaCliDeps = {
  /** Sync command runner (default: the ambient-authority-approved procRunner). */
  run?: CommandRunner | undefined;
  /** The `prx` executable to invoke (default: "prx" on PATH, per DEFAULT_PRX_BINARY). */
  prxBinary?: string | undefined;
  /** Diagnostic sink for the tolerated non-zero-exit-but-valid-array case. */
  warn?: ((line: string) => void) | undefined;
};

/**
 * Aggregate bead read via the daemon, as a synchronous `prx beads list` spawn.
 * Mirrors `loadAllBeads`'s parse tolerance: a complete, valid array is honored
 * even on a non-zero exit (a post-listing side effect), but an empty/garbled
 * result on a non-zero exit throws rather than silently reporting zero beads.
 */
export function loadAllBeadsViaCli(deps: LoadAllBeadsViaCliDeps = {}): BeadsRecord[] {
  const run = deps.run ?? procRunner;
  const bin = deps.prxBinary ?? "prx";
  const warn = deps.warn ?? (() => {});

  const result = run([bin, "beads", "list", "--all", "--limit", "0"], { check: false });

  let raw: unknown;
  let parseError = false;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    parseError = true;
  }
  const parsedArray = !parseError && Array.isArray(raw) ? (raw as unknown[]) : null;
  // A non-empty array proves the listing actually ran; empty stdout (coerced to
  // "[]") does NOT — that's the shape a crashed/blocked/missing CLI produces.
  const listingRan = parsedArray !== null && result.stdout.trim().length > 0;

  if (result.status !== 0) {
    if (listingRan) {
      const detail = result.stderr.trim() || `exit code ${result.status}`;
      warn(
        `beads daemon read: prx beads list exited non-zero but emitted a valid array; using it (${detail})`,
      );
    } else {
      const detail = result.stderr.trim() || result.stdout.trim() || "prx beads list failed";
      throw new Error(`beads daemon read: ${detail}`);
    }
  } else if (parseError) {
    throw new Error("beads daemon read: prx beads list returned invalid JSON");
  } else if (parsedArray === null) {
    throw new Error("beads daemon read: expected prx beads list to return an array");
  }

  return parseBeadsRecords(parsedArray ?? []);
}
