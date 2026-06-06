/**
 * @bounded-systems/repo-root — the repo-root resolution capability.
 *
 * The ONE place the project's root directory is resolved. Two mechanisms, one
 * owner:
 *
 *   • getRepoRoot(cwd?) — LAZY runtime resolver via `git rev-parse --show-toplevel`
 *     (routed through @bounded-systems/proc). Safe in the compiled `prx` binary,
 *     which lives in bun's virtual fs (`/$bunfs/root`, no `.git` ancestor): it
 *     resolves from the working directory, not the module location, and never at
 *     import time. Memoized for the process; `resetRepoRootCache()` clears it.
 *
 *   • findRepoRoot(start?) — EAGER `.git`-marker ancestor walk from a source-file
 *     location, for build/codegen scripts and tests that run from source (where
 *     `.git` is always present). Throws if no `.git` ancestor exists.
 *
 * Critically there is NO module-level resolution here: importing this package has
 * no side effect, so pulling it into any import graph — including the runtime CLI —
 * cannot crash on a missing `.git`. (The old eager `REPO_ROOT` const did exactly
 * that to the compiled binary; this capability replaces it.)
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runCaptured, type CommandRunner } from "@bounded-systems/proc";

/**
 * The nearest ancestor of `start` containing a `.git` entry (a directory in a
 * normal checkout, a file in a git worktree). Throws if none is found. Eager and
 * side-effect-bearing only when CALLED — never at import. Defaults to this
 * module's location, so source-run scripts/tests resolve the enclosing checkout.
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

let cached: string | undefined;

/**
 * The repo root for the running process, resolved lazily from `cwd` via git and
 * memoized. The `run` seam is injectable for tests; production uses
 * @bounded-systems/proc. Falls back to `cwd` if git reports nothing (e.g. not a
 * repo) rather than throwing — the runtime CLI degrades, it doesn't crash.
 */
export function getRepoRoot(cwd: string = process.cwd(), run: CommandRunner = runCaptured): string {
  if (cached !== undefined) return cached;
  const top = run(["git", "rev-parse", "--show-toplevel"], { cwd, check: false }).stdout.trim();
  cached = top || cwd;
  return cached;
}

/** Clear the `getRepoRoot` memo — for tests that exercise resolution. */
export function resetRepoRootCache(): void {
  cached = undefined;
}
