/**
 * Default `--scope` from cwd worktree (GH-876).
 *
 * Scope-taking prx verbs (today: `prx intake`) read this helper when the
 * operator hasn't passed `--scope` explicitly. The helper resolves the cwd's
 * GitHub origin and maps it to the conventional-commits scope used by that
 * repo's intake-log issues.
 *
 * Explicit `--scope` always wins — callers fill from inference only when the
 * flag is unset. `mainx` worktrees are excluded by design (they're the ops
 * surface; force explicit scope).
 */

import { basename } from "node:path";

import { spawnCapture } from "@bounded-systems/proc";

import { parseGithubRepo } from "./github.js";
import { readOperatorConfigStringMap } from "../operator-config.ts";

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => { stdout: string; stderr: string; status: number | null };

export const defaultRunner: CommandRunner = (cmd, args, opts) => {
  const result = spawnCapture([cmd, ...args], { cwd: opts.cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
};

export type InferredScope =
  | { scope: string; source: "git-remote"; mapping: string }
  | {
      scope: null;
      source: "skipped";
      reason: "mainx" | "no-mapping" | "no-remote";
    };

/**
 * Owner/repo → conventional-commits scope. GH-411 slice 4: this map is no longer
 * hardcoded to a personal repo — it's read from `scopeMap` in
 * `~/.config/prx/config.json` (e.g. `{"scopeMap": {"owner/repo": "prx"}}`). An
 * unconfigured operator gets `{}` → inference returns `no-mapping` and the caller
 * falls back to requiring an explicit `--scope`.
 */
export function readConfiguredScopeMap(deps?: {
  readFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  homeDir?: string;
}): Record<string, string> {
  return readOperatorConfigStringMap("scopeMap", deps ?? {});
}

/**
 * Pure predicate: a worktree path points at the read-only `mainx` replica.
 *
 * The single definition of "what is mainx" — both `isMainxWorktree` (cwd →
 * git toplevel → here) and the workspace/session fail-closed guards (I-WS5,
 * resolved ledger `worktree_path` → here) route through it so the signal can
 * never drift between detection sites. `mainx` is the only detached shared
 * replica, so the directory basename is the canonical signal (branch-name
 * checks don't work on its detached HEAD).
 */
export function isMainxPath(worktreePath: string): boolean {
  return basename(worktreePath) === "mainx";
}

/**
 * True when `cwd`'s git toplevel basename is `mainx`. mainx worktrees are
 * detached at origin/main, so branch-name checks don't work — the worktree
 * directory name is the canonical signal.
 *
 * Returns false (not-mainx) when git rev-parse fails, so callers don't
 * accidentally treat a non-git path as the ops surface.
 */
export function isMainxWorktree(cwd: string, runner: CommandRunner = defaultRunner): boolean {
  const toplevel = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  if ((toplevel.status ?? 1) !== 0) return false;
  return isMainxPath(toplevel.stdout.trim());
}

export function inferOperatorScopeFromCwd(
  cwd: string,
  runner: CommandRunner = defaultRunner,
  scopeMap: Record<string, string> = readConfiguredScopeMap(),
): InferredScope {
  const remote = runner("git", ["-C", cwd, "remote", "get-url", "origin"], { cwd });
  if ((remote.status ?? 1) !== 0) {
    return { scope: null, source: "skipped", reason: "no-remote" };
  }
  const key = parseGithubRepo(remote.stdout);
  if (!key) {
    return { scope: null, source: "skipped", reason: "no-remote" };
  }

  // mainx is the ops surface — force explicit --scope.
  if (isMainxWorktree(cwd, runner)) {
    return { scope: null, source: "skipped", reason: "mainx" };
  }

  const scope = scopeMap[key];
  if (!scope) {
    return { scope: null, source: "skipped", reason: "no-mapping" };
  }
  return { scope, source: "git-remote", mapping: key };
}
