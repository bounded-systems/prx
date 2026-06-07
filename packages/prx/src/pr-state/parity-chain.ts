// Parity-chain side-effect primitives, extracted from the monolithic
// `pr-state/cli.ts` (GH-519 / GH-520).
//
// These two functions are surface-sync / git primitives, not CLI plumbing.
// They lived in `cli.ts` only by accretion, which forced any consumer — e.g.
// the triage `pruneMergedActor` (`triage/prune-merged.ts`) — to import the
// entire 23k-line CLI just to reach them. That pulled `pr-state/cli.ts` (and
// transitively `triage/prime.ts → triage/machine.ts → triage/actors.ts`) into
// the triage actors' module graph, creating an `actors ↔ machine` import cycle
// (a TDZ on `statusActor`) plus a heavy load-time dependency. Housing them in
// this focused leaf module breaks that edge; `cli.ts` re-exports them so its
// existing callers are unaffected.

import { surfaceSyncExecContext, commandForSurfaceSyncAction, type SurfaceSyncExecContext } from "./github.ts";
import { procSpawnLike, resolveRepoRootWithSpawn, type SpawnLike } from "./cli-spawn.ts";
import type { ParityChainApplyResult } from "./cli-types.ts";
import type { SurfaceSyncResult } from "@bounded-systems/surface-sync";

/**
 * GH-519: drop stale origin/GH-NNN remote-tracking refs before the parity
 * chain evaluates remote state.
 *
 * After a PR merges with `--delete-branch`, the remote branch is gone but
 * the local `origin/GH-NNN` ref lingers. The parity chain then sees a
 * "dirty" remote branch and demands `delete_remote_branch` against a ref
 * that's already gone, blocking `prx session open`.
 *
 * Best-effort: network errors or detached/sandbox runs should not abort
 * session open — we silently ignore fetch failures.
 */
export function pruneStaleRemoteRefs(
  cwd: string = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
): void {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  spawn("git", ["-C", repoRoot, "fetch", "--prune", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

/**
 * GH-520: execute each surface-sync action, returning one result per action.
 * Continue-on-error: a failure in one action does not halt the remaining
 * actions — they are independent reconciliation steps and the caller decides
 * the overall exit status.
 *
 * The action is an env-agnostic intent; this executor maps it to a command via
 * `commandForSurfaceSyncAction(intent, ctx)` (github.ts implements the spec),
 * then invokes `/bin/sh -c "<command>"`. The derived command is recorded on
 * the result.
 */
export function applyParityChainActions(
  summary: SurfaceSyncResult,
  cwd: string = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
  ctx: SurfaceSyncExecContext = surfaceSyncExecContext(cwd),
): ParityChainApplyResult[] {
  return summary.actions.map((action) => {
    const command = commandForSurfaceSyncAction(action, ctx);
    const result = spawn("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
    });
    return {
      action,
      command,
      status: result.status ?? 1,
      stdout: (result.stdout ?? "").toString(),
      stderr: (result.stderr ?? "").toString(),
    };
  });
}
