/**
 * Worktree placement layout — single source of truth for the on-disk
 * sibling path of a branch and the pure `git worktree add` core.
 *
 * The worktrunk layout places every worktree of a repo as a sibling of
 * the repo toplevel, named by the branch (or work-unit id):
 *
 *     <dirname(repoToplevel)>/<branch>
 *
 * Both `prx`'s work-unit materializer (`src/pr-state/cli.ts`) and the
 * `workspace.materialize` actor verb (`src/workspace/actor.ts`) derive
 * the path through `expectedWorktreePath` and add the worktree through
 * `addWorktreeForBranch`, so the two paths can never drift (ai-home-rkg1w.1
 * §3.3). This module owns only the placement rule + the pure git op; it
 * carries no work-unit-id validation — that stays in the CLI handler.
 */

import { dirname, join } from "node:path";

/** Result shape shared by the cli SpawnLike seam and the actor's default. */
export type WorktreeSpawnResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

export type WorktreeSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; env?: NodeJS.ProcessEnv },
) => WorktreeSpawnResult;

/**
 * Thrown when `git worktree add` exits non-zero. Callers that want a
 * domain-specific error (e.g. cli `CliError`) catch this and rewrap;
 * raw spawn errors (`result.error`) propagate unwrapped.
 */
export class WorktreeAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeAddError";
  }
}

/**
 * The canonical on-disk path for a branch's worktree: a sibling of the
 * repo toplevel named by the branch. `branch` may contain slashes
 * (e.g. `triage/20260526-8012e9`) — that nests under the parent dir,
 * which is the intended layout for ephemeral session worktrees.
 */
export function expectedWorktreePath(repoRoot: string, branch: string): string {
  return join(dirname(repoRoot), branch);
}

/** Whether `targetPath` is already a registered worktree of `repoRoot`. */
export function isRegisteredWorktree(
  repoRoot: string,
  targetPath: string,
  spawn: WorktreeSpawn,
): boolean {
  const listResult = spawn("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listResult.error) throw listResult.error;
  if ((listResult.status ?? 1) !== 0) return false;
  return (listResult.stdout ?? "").split("\n").some((line) => line === `worktree ${targetPath}`);
}

/**
 * Pure `git worktree add` core. When the local branch already exists it
 * checks it out into `targetPath`; otherwise it creates the branch off
 * `origin/main`. Throws the raw spawn error on a spawn failure, or a
 * `WorktreeAddError` on a non-zero git exit.
 */
export function addWorktreeForBranch(
  repoRoot: string,
  branch: string,
  targetPath: string,
  spawn: WorktreeSpawn,
): void {
  const branchExistsResult = spawn(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (branchExistsResult.error) throw branchExistsResult.error;

  const branchExists = (branchExistsResult.status ?? 1) === 0;
  const args = branchExists
    ? ["-C", repoRoot, "worktree", "add", targetPath, branch]
    : ["-C", repoRoot, "worktree", "add", "-b", branch, targetPath, "origin/main"];
  const addResult = spawn("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (addResult.error) throw addResult.error;
  if ((addResult.status ?? 1) !== 0) {
    const message =
      (addResult.stderr ?? addResult.stdout ?? "").trim() ||
      `git worktree add failed for ${branch}`;
    throw new WorktreeAddError(message);
  }
}
