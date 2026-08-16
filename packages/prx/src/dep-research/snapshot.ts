// dep-research snapshot builder + atomic writer (GH-1274, PR-2 of GH-1261).
//
// `buildSnapshot` is pure: it digests fetched bytes into a `DepSnapshot`
// validated against the PR-1 schema. `writeSnapshot` is the substrate writer
// — atomic tmp-dir + rename per invariant I-DR3 — so a partially-completed
// run never leaves a half-written `<dep>/<run_id>/` directory in place.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DepSnapshot } from "./schemas.ts";

/** Args to {@link buildSnapshot} — the caller has already fetched bytes. */
export type BuildSnapshotArgs = {
  dep: string;
  runId: string;
  fetchedAt: string;
  fetched: Record<string, Buffer>;
  failures: Record<string, string>;
};

/**
 * Compose a {@link DepSnapshot} from already-fetched bytes. Pure: no IO,
 * no clock, no randomness — every input arrives via `args`. The output is
 * round-tripped through `DepSnapshot.parse` so callers can rely on the
 * boundary contract (per `reference_zod_boundary_layer.md`).
 *
 * Failed paths surface as `run_state: "failed"` and are absent from the
 * `source_sha256` / `source_byte_len` records. The set of failures can be
 * recovered by comparing manifest paths against `source_sha256` keys.
 */
export function buildSnapshot(args: BuildSnapshotArgs): DepSnapshot {
  const sourceSha256: Record<string, string> = {};
  const sourceByteLen: Record<string, number> = {};

  for (const [path, bytes] of Object.entries(args.fetched)) {
    sourceSha256[path] = createHash("sha256").update(bytes).digest("hex");
    sourceByteLen[path] = bytes.byteLength;
  }

  const runState = Object.keys(args.failures).length > 0 ? "failed" : "ok";

  return DepSnapshot.parse({
    dep: args.dep,
    run_id: args.runId,
    fetched_at: args.fetchedAt,
    source_sha256: sourceSha256,
    source_byte_len: sourceByteLen,
    run_state: runState,
  });
}

/**
 * Atomically materialize a snapshot under `<baseDir>/<dep>/<runId>/`.
 *
 * Strategy: write the run directory to a sibling tmp path and `renameSync`
 * the whole directory into place. Since the tmp path is a sibling of the
 * target (same filesystem by construction), the rename is atomic on POSIX
 * — no partial `<runId>/` directory ever appears. On rename failure the
 * tmp directory is best-effort cleaned up so the operator can retry.
 *
 * Returns the absolute path of the materialized run directory.
 */
export function writeSnapshot(snapshot: DepSnapshot, baseDir: string): string {
  const depDir = join(baseDir, snapshot.dep);
  mkdirSync(depDir, { recursive: true });

  const tmpDir = join(depDir, `.tmp.${snapshot.run_id}.${process.pid}`);
  const finalDir = join(depDir, snapshot.run_id);

  mkdirSync(tmpDir, { recursive: true });
  try {
    writeFileSync(join(tmpDir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tmpDir, finalDir);
  } catch (err) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the original error is the one the caller cares
      // about.
    }
    throw err;
  }

  return finalDir;
}

/**
 * Compact, sortable run-id format: `YYYYMMDDTHHMMSSZ` (UTC). Stable across
 * runs in the same second is acceptable here — the operator drives one run
 * at a time per dep, and a same-second collision would still produce a
 * deterministic snapshot for that input.
 */
export function formatRunId(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}` +
    `${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}` +
    `${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}Z`
  );
}
