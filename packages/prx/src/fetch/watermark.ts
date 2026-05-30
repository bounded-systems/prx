// GH-1245 — watermark wrapper for the fetch actor spike.
//
// Beads owns the substrate, so the spike puts the watermark in
// `bd config` under a `prx.fetch.*` namespace (spike doc §6, decision
// log 2026-05-02). That gives clone-survival, queryability via SQL +
// CLI, and reuse of bd's existing concurrency model without inventing
// parallel state.
//
// The spike only exercises **read** at runtime — `setWatermark` exists
// so the deliverable-2 probe (cost projection drops to ~0 after a
// manual `bd github sync` writes the watermark) can be re-run from a
// clean slate without leaving stale state behind. The post-spike write
// ticket (spike doc §12 Ticket A) is the first caller that advances
// the watermark from inside the verb.

import { spawnCapture } from "@bounded-systems/proc";

export const WATERMARK_KEY = "prx.fetch.gh-issues.watermark";
export const LAST_POINTS_KEY = "prx.fetch.gh-issues.last-points";

export type SpawnResult = { stdout: string; stderr: string; status: number };

export type SpawnRunner = (
  cmd: string[],
  options?: { cwd?: string },
) => SpawnResult;

// Routes the bd-config read through @bounded-systems/proc's sync capture primitive (no raw
// spawn). Stays synchronous: watermark is internal infra read from sync seams
// across scout/triage/fetch — the async ProcExecutor contract is the
// remote-ready path for new code, not a forced rewrite of those seams here.
export const defaultSpawnRunner: SpawnRunner = (cmd, options = {}) => {
  const result = spawnCapture(cmd, options.cwd !== undefined ? { cwd: options.cwd } : {});
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
  };
};

export class WatermarkError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "WatermarkError";
    this.code = code;
  }
}

export type WatermarkDeps = {
  cwd: string;
  runner?: SpawnRunner | undefined;
};

/**
 * Read `prx.fetch.gh-issues.watermark` from `bd config`. Returns
 * `{ since: null }` when the key is absent. bd has two version-dependent
 * "absent" representations and both are coerced to `null`:
 *   - exit 0 with stdout `"<key> (not set)\n"` (current bd)
 *   - non-zero exit with stderr `"config key not set"` (legacy bd)
 * Throws `WatermarkError` only when the spawn itself failed for some
 * other reason (e.g., bd binary missing).
 */
export function getWatermark(
  deps: WatermarkDeps,
): { since: string | null } {
  const runner = deps.runner ?? defaultSpawnRunner;
  const result = runner(["bd", "config", "get", WATERMARK_KEY], {
    cwd: deps.cwd,
  });
  if (result.status === 0) {
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return { since: null };
    // bd's exit-0 absent mode emits "<key> (not set)" on stdout. The
    // parenthesized sentinel is the load-bearing marker — legitimate
    // ISO-8601 timestamps cannot contain it.
    if (trimmed.toLowerCase().includes("(not set)")) return { since: null };
    return { since: trimmed };
  }
  // Legacy bd's exit-1 absent mode surfaces on stderr; coerce to null
  // so callers can treat absence and an explicit empty value identically.
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes("not set") || combined.includes("not found")) {
    return { since: null };
  }
  throw new WatermarkError(
    `bd config get ${WATERMARK_KEY} failed (exit ${result.status}): ${result.stderr.trim()}`,
    "WATERMARK_READ_FAILED",
  );
}

/**
 * Read `prx.fetch.gh-issues.last-points` from `bd config`. Returns
 * `{ points: null }` when the key is absent or stores a non-integer
 * value. Mirrors `getWatermark`'s absent-mode handling — both the
 * exit-0 `(not set)` sentinel and the legacy exit-1 stderr coerce to
 * `null`. Throws `WatermarkError` only when the spawn itself fails
 * for some other reason (e.g., bd binary missing).
 */
export function getLastPoints(
  deps: WatermarkDeps,
): { points: number | null } {
  const runner = deps.runner ?? defaultSpawnRunner;
  const result = runner(["bd", "config", "get", LAST_POINTS_KEY], {
    cwd: deps.cwd,
  });
  if (result.status === 0) {
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return { points: null };
    if (trimmed.toLowerCase().includes("(not set)")) return { points: null };
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) return { points: null };
    return { points: n };
  }
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes("not set") || combined.includes("not found")) {
    return { points: null };
  }
  throw new WatermarkError(
    `bd config get ${LAST_POINTS_KEY} failed (exit ${result.status}): ${result.stderr.trim()}`,
    "LAST_POINTS_READ_FAILED",
  );
}

/**
 * Write `prx.fetch.gh-issues.watermark` to `bd config`. Unused by the
 * spike's read-only verb; lands here so the deliverable-2 measurement
 * (cost projection drops to ~0 after watermark advance) can be re-run
 * from scratch and so the post-spike write ticket has the seam.
 */
export function setWatermark(
  deps: WatermarkDeps,
  since: string,
): void {
  const runner = deps.runner ?? defaultSpawnRunner;
  const result = runner(["bd", "config", "set", WATERMARK_KEY, since], {
    cwd: deps.cwd,
  });
  if (result.status !== 0) {
    throw new WatermarkError(
      `bd config set ${WATERMARK_KEY} failed (exit ${result.status}): ${result.stderr.trim()}`,
      "WATERMARK_WRITE_FAILED",
    );
  }
}
