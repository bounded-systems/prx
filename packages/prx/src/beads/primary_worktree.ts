/**
 * Primary-vs-feature worktree classification (GH-653).
 *
 * Pure git wrapper used by `bootstrapBeads` and `hydrate` to decide whether
 * the cwd is the repo's primary worktree (owns its own `.beads/dolt/{db}`)
 * or a linked feature worktree (must redirect to primary's `.beads`).
 *
 * Classification is purely structural via `git rev-parse --git-common-dir`.
 * For a standard repo, common-dir is `<worktree>/.git`. For a linked
 * worktree, it's `<primary>/.git`. In both cases, the primary worktree is
 * the parent of the .git directory.
 *
 * The structural check cannot be fooled by a stale per-worktree `dolt` dir
 * — even if a feature worktree has accidentally accumulated its own dolt
 * data, this still returns the correct primary path so callers can write a
 * redirect to the canonical .beads.
 */

import { resolve } from "node:path";

import { spawnCapture } from "@bounded-systems/proc";

/**
 * Resolve the path to the repo's primary (main) worktree from any cwd.
 * Returns null when git common-dir is unresolvable (non-git cwd, broken
 * gitdir link, etc).
 */
export function resolveMainWorktree(cwd: string): string | null {
  const r = spawnCapture(["git", "-C", cwd, "rev-parse", "--git-common-dir"]);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!out) return null;
  const absolute = resolve(cwd, out);
  if (absolute.endsWith("/.git") || absolute.endsWith("/.git/")) {
    return absolute.replace(/\/\.git\/?$/, "");
  }
  return null;
}

/**
 * `true` when `cwd` is the repo's primary worktree, `false` when it's a
 * linked feature worktree, `null` when classification is impossible (cwd
 * is not inside a git repo). Callers in `bootstrap_worktree` and `hydrate`
 * map `null` to existing skip statuses (`skipped-no-git-common-dir` and
 * "fall through to existing logic" respectively).
 */
export function isPrimaryWorktree(cwd: string): boolean | null {
  const main = resolveMainWorktree(cwd);
  if (!main) return null;
  return resolve(main) === resolve(cwd);
}
