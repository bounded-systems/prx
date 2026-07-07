/**
 * Resolve a repo cwd's git-common-dir (shared by container-runner.ts, for
 * mounting, and workspace_mode.ts, for classification).
 *
 * This ecosystem's usual layout is a bare repo + separate linked worktrees
 * (`prx repo materialize`/`repo add`), so a worktree's `.git` is a FILE
 * pointing at an absolute `<bareRepo>/worktrees/<name>` path outside the
 * worktree itself — `git rev-parse --git-common-dir` resolves that back to
 * `<bareRepo>` directly (bare repos have no nested `.git`, unlike the
 * standard primary+linked shape `resolveMainWorktree` in `primary_worktree.ts`
 * targets — see that module's GH-1680 regression case for the contrast).
 */
import { spawnCapture } from "@bounded-systems/proc";

/**
 * Absolute git-common-dir for `repo`, or `undefined` when it's the same as
 * `repo` (a self-contained checkout — nothing to redirect to) or git fails
 * (not a repo at all).
 */
export function resolveGitCommonDir(repo: string): string | undefined {
  const r = spawnCapture(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.status !== 0) return undefined;
  const commonDir = r.stdout.trim();
  if (!commonDir) return undefined;
  if (commonDir === repo || commonDir.startsWith(`${repo}/`)) return undefined;
  return commonDir;
}
