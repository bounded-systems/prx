// prx-g88.5 (C5) — ephemeral salted worktrees (docs/capability-orchestrator.md
// §4). Each actor sub-agent runs in its OWN salted worktree on its OWN salted
// branch, both created on start and destroyed on finish. The salt comes from C4
// (intake-minted unit salt ⊗ actor identity), so no two actors ever share a
// worktree or branch checkout — which makes the keeper `switch -C` collision
// (prx-5l3) structurally impossible.
//
// The ONLY durable state is the signed CAS artifact an actor hands off; these
// branches are scaffolding. Nothing here pushes to origin — keeper's published
// PR branch is materialized from the artifact at publish, separately.

import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execGit } from "@bounded-systems/git";
import {
  actorBranchName,
  actorSalt,
  actorWorktreeDirName,
  unitSalt,
} from "../provenance/actor-salt.ts";

/** Where ephemeral actor worktrees live, relative to the repo root. */
export const EPHEMERAL_WORKTREE_DIR = ".wt";

export class EphemeralWorktreeError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "EphemeralWorktreeError";
  }
}

export interface EphemeralWorktreeSpec {
  readonly actor: string;
  readonly unit: string;
  /** The `<unit>:source@pinned` digest — mints the salt (C4). Intake-bound. */
  readonly sourcePinnedDigest: string;
  /** Repo root the `.wt/` dir + git ops run against. */
  readonly repoRoot: string;
  /** Git ref to cut the ephemeral branch from. Default `origin/main`. */
  readonly base?: string;
}

export interface EphemeralWorktreeHandle {
  readonly actor: string;
  readonly unit: string;
  readonly salt: string;
  /** Absolute worktree path (`<repoRoot>/.wt/<actor>-<salt>`). */
  readonly path: string;
  /** The ephemeral branch (`<actor>/<unit>-<salt>`). */
  readonly branch: string;
  readonly repoRoot: string;
}

export interface EphemeralWorktreeDeps {
  git?: typeof execGit;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
}

/** Derive the (path, branch, salt) for an actor's ephemeral worktree — no side effects. */
export function ephemeralWorktreeHandle(spec: EphemeralWorktreeSpec): EphemeralWorktreeHandle {
  const salt = actorSalt(unitSalt(spec.sourcePinnedDigest), spec.actor);
  return {
    actor: spec.actor,
    unit: spec.unit,
    salt,
    path: resolve(spec.repoRoot, EPHEMERAL_WORKTREE_DIR, actorWorktreeDirName(spec.actor, salt)),
    branch: actorBranchName(spec.actor, spec.unit, salt),
    repoRoot: resolve(spec.repoRoot),
  };
}

/** Create the actor's ephemeral worktree + salted branch (cut from `base`). */
export function createEphemeralActorWorktree(
  spec: EphemeralWorktreeSpec,
  deps: EphemeralWorktreeDeps = {},
): EphemeralWorktreeHandle {
  const git = deps.git ?? execGit;
  const handle = ephemeralWorktreeHandle(spec);
  const base = spec.base ?? "origin/main";
  const added = git({
    subcommand: "worktree",
    args: ["add", "-b", handle.branch, handle.path, base],
    cwd: handle.repoRoot,
    role: "keeper",
  });
  if (added.exitCode !== 0) {
    throw new EphemeralWorktreeError(
      `ephemeral worktree add failed for ${handle.branch} (${added.exitCode}): ${added.stderr.trim()}`,
      added.exitCode,
    );
  }
  return handle;
}

/** Destroy an actor's ephemeral worktree + salted branch. Best-effort, idempotent. */
export function destroyEphemeralActorWorktree(
  handle: EphemeralWorktreeHandle,
  deps: EphemeralWorktreeDeps = {},
): void {
  const git = deps.git ?? execGit;
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));

  git({ subcommand: "worktree", args: ["remove", "--force", handle.path], cwd: handle.repoRoot, role: "keeper" });
  if (exists(handle.path)) remove(handle.path);
  // Delete the ephemeral branch — nothing durable escapes the agent.
  git({ subcommand: "branch", args: ["-D", handle.branch], cwd: handle.repoRoot, role: "keeper" });
  git({ subcommand: "worktree", args: ["prune"], cwd: handle.repoRoot, role: "keeper" });
}

/**
 * Run `fn` inside a freshly-created ephemeral actor worktree, then destroy it —
 * even if `fn` throws. This is the lifecycle: the worktree + branch live exactly
 * as long as the agent's work, then vanish.
 */
export async function withEphemeralActorWorktree<T>(
  spec: EphemeralWorktreeSpec,
  fn: (handle: EphemeralWorktreeHandle) => T | Promise<T>,
  deps: EphemeralWorktreeDeps = {},
): Promise<T> {
  const handle = createEphemeralActorWorktree(spec, deps);
  try {
    return await fn(handle);
  } finally {
    destroyEphemeralActorWorktree(handle, deps);
  }
}

/**
 * Sweep orphaned ephemeral worktrees (whose agent died without cleanup). Lists
 * registered worktrees under `<repoRoot>/.wt/` and removes those for which
 * `isOrphan` returns true (default: all — the gc-sweep posture). Returns the
 * removed worktree paths. Wire into `gc inventory` / `gc run`.
 */
export function sweepOrphanedActorWorktrees(
  repoRoot: string,
  deps: EphemeralWorktreeDeps & { isOrphan?: (path: string) => boolean } = {},
): string[] {
  const git = deps.git ?? execGit;
  const root = resolve(repoRoot);
  const wtPrefix = join(root, EPHEMERAL_WORKTREE_DIR) + "/";
  const isOrphan = deps.isOrphan ?? (() => true);

  const list = git({ subcommand: "worktree", args: ["list", "--porcelain"], cwd: root, role: "keeper" });
  const paths: string[] = [];
  for (const line of (list.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p.startsWith(wtPrefix) && isOrphan(p)) paths.push(p);
    }
  }
  const removed: string[] = [];
  for (const p of paths) {
    const r = git({ subcommand: "worktree", args: ["remove", "--force", p], cwd: root, role: "keeper" });
    if (r.exitCode === 0) removed.push(p);
  }
  if (removed.length > 0) git({ subcommand: "worktree", args: ["prune"], cwd: root, role: "keeper" });
  return removed;
}
