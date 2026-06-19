/**
 * bd schema drift detection and repair (GH-1152).
 *
 * Background. v0.63.x → v1.0.x upgrades hit a non-idempotent ALTER batch in
 * SQL migration 0027 (`add_started_at`); when the batch aborted partway,
 * `schema_migrations` recorded version 27 as applied but `issues.started_at`
 * was missing. Result: `bd export` (and other commands that hit
 * `IssueSelectColumns`) blew up with `Error 1105 (HY000): column "started_at"
 * could not be found in any table in scope`.
 *
 * Fix landed upstream in `gastownhall/beads` PR #3365 (v1.0.3) as a defensive
 * compat migration: `internal/storage/dolt/migrations/017_add_started_at_column.go`.
 * It guards each ALTER on a `columnExists` check, so it's idempotent and
 * safe to re-run. The migration runs as a side-effect of `RunCompatMigrations`,
 * which fires on the first bd command that opens the DB after install.
 *
 * Local install (`bd 1.0.3 (dev)`) carries the fix, but `bootstrapBeads`
 * never invokes a bd command — so feature worktrees that skip the trigger
 * stay broken until something happens to open the DB. This module is the
 * trigger: a single shell-out site that runs the lightest available bd
 * command, with the runner injected so tests don't need a real bd binary.
 */

import { captureFailureDetail, isCaptureFailure, spawnCapture } from "@bounded-systems/proc";
import { z } from "zod";

export const BdSchemaProbeResultSchema = z.object({
  status: z.enum(["healthy", "drift_detected", "probe_failed"]),
  errorClass: z.enum(["started_at_missing", "unknown"]).optional(),
  rawStderr: z.string().optional(),
});
export type BdSchemaProbeResult = z.infer<typeof BdSchemaProbeResultSchema>;

export const BdSchemaRepairResultSchema = z.object({
  status: z.enum(["repaired", "already_healthy", "repair_failed", "skipped_no_bd"]),
  durationMs: z.number(),
  command: z.string(),
  message: z.string().optional(),
});
export type BdSchemaRepairResult = z.infer<typeof BdSchemaRepairResultSchema>;

export type BdRunResult = { exitCode: number; stdout: string; stderr: string };
export type BdRunner = (args: string[], cwd: string) => BdRunResult;

/**
 * Default runner — invokes `bd` from PATH. Tests inject a stub.
 *
 * GH-1609: streams stdout through `spawnCapture` so a bd response that grows
 * past Node's default 1 MiB stdout cap cannot ENOBUFS/SIGTERM the child and
 * surface partial bytes as the probe result. The drift classifier reads
 * `result.stderr` to detect the started_at signature; on a capture failure
 * (signal / spawn error) stderr is prefixed with `bd-safe:` so a stray ENOBUFS
 * can never be mistaken for a healthy bd response, while the substring match
 * the classifier uses still resolves against the original stderr.
 */
export const defaultBdRunner: BdRunner = (args, cwd) => {
  const result = spawnCapture(["bd", ...args], { cwd });
  if (isCaptureFailure(result) && (result.error || result.signal)) {
    return {
      exitCode: result.status ?? 1,
      stdout: "",
      stderr: `bd-safe: ${captureFailureDetail(result) || "bd failed"}`,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const STARTED_AT_DRIFT_PATTERN = /column\s+"?started_at"?\s+could not be found/i;

function classifyStderr(stderr: string): BdSchemaProbeResult["errorClass"] {
  if (STARTED_AT_DRIFT_PATTERN.test(stderr)) return "started_at_missing";
  return "unknown";
}

/**
 * Probe the bd schema by issuing a lightweight read that hits the search
 * column list. `bd stats --json` is the lightest command that opens the
 * Dolt DB and triggers `RunCompatMigrations`; on a drifted DB it returns
 * non-zero with the `started_at` substring in stderr.
 *
 * The probe itself triggers compat migration 017, so a `drift_detected`
 * result on a stable bd ≥1.0.3 binary should clear on the very next probe
 * — which is exactly the property `repairBdSchema` relies on.
 */
export function probeBdSchema(
  cwd: string,
  runner: BdRunner = defaultBdRunner,
): BdSchemaProbeResult {
  const result = runner(["stats", "--json"], cwd);
  if (result.exitCode === 0) {
    return { status: "healthy" };
  }
  const errorClass = classifyStderr(result.stderr);
  if (errorClass === "started_at_missing") {
    return { status: "drift_detected", errorClass, rawStderr: result.stderr };
  }
  return { status: "probe_failed", errorClass, rawStderr: result.stderr };
}

/**
 * Repair a bd schema by running a single `bd stats` (deliberately *not*
 * `bd doctor --fix` — the compat migration runs on any DB-opening command,
 * and `bd stats` is faster than `doctor`).
 *
 * Idempotent: on an already-healthy DB this is a no-op read; on a drifted
 * DB the first invocation triggers compat migration 017 and the second
 * succeeds.
 */
export function repairBdSchema(
  cwd: string,
  runner: BdRunner = defaultBdRunner,
): BdSchemaRepairResult {
  const command = "bd stats --json";
  const start = performance.now();
  const first = runner(["stats", "--json"], cwd);
  if (first.exitCode === 0) {
    return {
      status: "already_healthy",
      durationMs: Math.round(performance.now() - start),
      command,
    };
  }

  const firstClass = classifyStderr(first.stderr);
  if (firstClass !== "started_at_missing") {
    return {
      status: "repair_failed",
      durationMs: Math.round(performance.now() - start),
      command,
      message: first.stderr.trim() || `bd stats exited ${first.exitCode}`,
    };
  }

  // Compat migration 017 runs on the first DB-opening command. Re-probe to
  // confirm the schema is healthy after the trigger.
  const second = runner(["stats", "--json"], cwd);
  const elapsed = Math.round(performance.now() - start);
  if (second.exitCode === 0) {
    return { status: "repaired", durationMs: elapsed, command };
  }
  return {
    status: "repair_failed",
    durationMs: elapsed,
    command,
    message:
      second.stderr.trim() ||
      `bd stats still failing after compat migration trigger (exit ${second.exitCode})`,
  };
}
