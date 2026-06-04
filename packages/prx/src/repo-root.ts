// Repo-root resolution for codegen + tests, robust to nesting depth.
//
// Replaces brittle `resolve(import.meta.dir, "../../..")` depth-counting (which
// differs between scripts and tests and silently resolves to the wrong dir when
// a file moves) with an ancestor walk to the `.git` marker. Dependency-free and
// spawn-free — distinct from the runtime `repoRoot(cwd)` in pr-state/github.ts,
// which shells `git rev-parse --show-toplevel` for an arbitrary working dir.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The nearest ancestor of `start` containing a `.git` entry (a directory in a
 * normal checkout, a file in a git worktree). Throws if none is found.
 */
export function findRepoRoot(start: string = import.meta.dir): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`findRepoRoot: no .git ancestor of ${start}`);
    dir = parent;
  }
}

/** The repo root, resolved once from this module's location. */
export const REPO_ROOT = findRepoRoot();
