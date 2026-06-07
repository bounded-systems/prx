// The cached layer for the local CI provenance projection (GH-352).
//
// Resolving the live verdict reads the anchored-chain ledger (async, sqlite) —
// too heavy for `prx snapshot`, which is a synchronous, ledger-free hot read
// (`statusline`/`phase`-class). So `prx ci` (which already has the ledger open
// when it signs) writes the verdict to a tiny cache, and `snapshot` reads it
// SYNC + recomputes freshness cheaply (is the cached commit still HEAD?). The
// provenance and the freshness signal already exist; this is just the cache
// seam between the async producer and the sync reader.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  DEFAULT_CI_PROVENANCE_STATE,
  type CiProvenanceState,
  type CiVerdict,
} from "./ci-provenance-state.ts";

export const ciProvenanceCacheSchema = z.object({
  kind: z.literal("CiProvenanceCacheV1"),
  /** The commit the verdict was resolved for. */
  commit: z.string(),
  /** The merge-guard verdict (from `resolveCiProvenanceState`) at write time. */
  verdict: z.enum(["verified", "unsigned", "unchecked"]),
  ts: z.number(),
}).strict();

export type CiProvenanceCache = z.infer<typeof ciProvenanceCacheSchema>;

/** `.pr/local/ci-provenance.json` — the cache the sync reader consults. */
export function ciProvenanceCachePath(cwd: string): string {
  return join(cwd, ".pr", "local", "ci-provenance.json");
}

/** Write the cached verdict for a commit (called by `prx ci` after it signs,
 *  while the ledger is open — the async producer side). */
export function writeCiProvenanceCache(
  cwd: string,
  entry: { commit: string; verdict: CiVerdict; ts?: number },
): void {
  const path = ciProvenanceCachePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const cache: CiProvenanceCache = {
    kind: "CiProvenanceCacheV1",
    commit: entry.commit,
    verdict: entry.verdict,
    ts: entry.ts ?? Date.now(),
  };
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/**
 * SYNC read of the cached CI provenance, with freshness recomputed against the
 * current commit — so the snapshot read stays ledger-free. The cached verdict is
 * `fresh` while its commit is still HEAD, `stale` once HEAD has moved past it
 * (the recorded green no longer covers the current tree), and `unknown` when the
 * current commit can't be determined. A missing/malformed cache ⇒ the
 * unchecked/unknown default.
 */
export function readCiProvenanceState(cwd: string, currentCommit: string): CiProvenanceState {
  const path = ciProvenanceCachePath(cwd);
  if (!existsSync(path)) return DEFAULT_CI_PROVENANCE_STATE;
  let cache: CiProvenanceCache;
  try {
    cache = ciProvenanceCacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_CI_PROVENANCE_STATE;
  }
  const freshness =
    currentCommit.length === 0 ? "unknown" : cache.commit === currentCommit ? "fresh" : "stale";
  return { verdict: cache.verdict, freshness };
}
