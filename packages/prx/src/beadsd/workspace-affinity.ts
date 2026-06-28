/**
 * Write-side workspace-affinity guard (prx-9e86).
 *
 * The beads daemon is host-global but a bd workspace prefix is repo-scoped, and
 * nothing binds them: `resolveLocalBeadsCwd` picks ONE served clone, and every
 * `prx beads` call from any worktree hits that same daemon. So a write issued
 * from a worktree whose repo prefix differs from the served clone's prefix lands
 * in the WRONG repo's beads (observed 2026-06-23: 54 supply-chain tasks created
 * with `prx-` ids while the operator was in the supply-plan-design worktree).
 *
 * This resolves the cwd's expected prefix and the served clone's prefix and
 * reports a definite mismatch — the write path refuses (fail CLOSED, same
 * posture as prx-w1v), the read path warns. Both prefixes must be known for a
 * mismatch: a null cwd prefix (cwd not in the repo inventory) can't establish
 * cross-repo intent, so it is allowed rather than blocking every unregistered
 * directory.
 *
 * Cost: the served prefix is read via {@link diagnoseBeads} (`bd config get
 * issue_prefix`, a subprocess). It is gated behind the cheap cwd-prefix lookup
 * (an index read) so the subprocess only runs when a mismatch is even possible.
 * Follow-up (prx-9e86): have the daemon report its served prefix on replies so
 * the read path can warn without a client-side subprocess.
 */

import { diagnoseBeads } from "../beads/doctor.ts";
import { runCaptured } from "@bounded-systems/proc";

import { localWorkspacePrefixForCwd } from "../pr-state/repos.ts";
import { parseGithubRepo } from "../pr-state/github.ts";
import { resolveLocalBeadsCwd } from "./client-factory.ts";

export interface WorkspaceAffinity {
  /** The cwd repo's bd prefix (from the repo inventory), or null if unknown. */
  cwdPrefix: string | null;
  /** The served clone's bd prefix (`bd config get issue_prefix`), or null. */
  servedPrefix: string | null;
  /** The cwd's git-remote repo identity — resolved only on prefix fallback. */
  cwdRepo: string | null;
  /** The served clone's git-remote repo identity — resolved only on fallback. */
  servedRepo: string | null;
  /** True on a definite cross-repo mismatch (by prefix, or by repo identity). */
  mismatch: boolean;
  /** Which axis triggered the mismatch (for the message), or null. */
  reason: "prefix" | "repo" | null;
}

export interface WorkspaceAffinityDeps {
  /** The worktree the operator is in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The clone the daemon serves. Defaults to {@link resolveLocalBeadsCwd}. */
  servedCwd?: string;
  /** cwd→prefix (index read). Defaults to {@link localWorkspacePrefixForCwd}. */
  localPrefix?: (cwd: string) => string | null;
  /** servedCwd→prefix (bd subprocess). Defaults to {@link diagnoseBeads}. */
  servedPrefix?: (servedCwd: string) => string | null;
  /** path→git-remote repo identity (`owner/repo`), or null. Default: git origin. */
  repoIdentity?: (path: string) => string | null;
}

/** A path's GitHub `owner/repo` from its git origin (cheap; null when absent). */
function defaultRepoIdentity(path: string): string | null {
  try {
    const r = runCaptured(["git", "-C", path, "remote", "get-url", "origin"], { check: false });
    if (r.status !== 0) return null;
    const url = r.stdout.trim();
    return url ? parseGithubRepo(url) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve whether a daemon write/read from `cwd` would cross into another repo's
 * beads. Fast path: compare the cwd's bd prefix to the served clone's prefix
 * (the served prefix is a bd subprocess, read only when the cwd prefix is known).
 *
 * prx-7odk fallback: when the cwd prefix is UNRESOLVABLE (cwd not in the repo
 * inventory), the prefix axis can't decide — so fall back to git-remote repo
 * identity. This catches an unregistered cross-repo write (which the prefix-only
 * guard let through) while NOT over-blocking a same-repo or undeterminable cwd:
 * a mismatch requires BOTH identities resolved and differing.
 */
export function resolveWorkspaceAffinity(deps: WorkspaceAffinityDeps = {}): WorkspaceAffinity {
  const cwd = deps.cwd ?? process.cwd();
  const servedCwd = deps.servedCwd ?? resolveLocalBeadsCwd();
  const cwdPrefix = (deps.localPrefix ?? localWorkspacePrefixForCwd)(cwd);

  if (cwdPrefix !== null) {
    const servedPrefix = (deps.servedPrefix ?? ((s) => diagnoseBeads({ cwd: s }).prefix))(servedCwd);
    const mismatch = servedPrefix !== null && cwdPrefix !== servedPrefix;
    return { cwdPrefix, servedPrefix, cwdRepo: null, servedRepo: null, mismatch, reason: mismatch ? "prefix" : null };
  }

  const repoIdentity = deps.repoIdentity ?? defaultRepoIdentity;
  const cwdRepo = repoIdentity(cwd);
  // Skip the second git call when the cwd identity is unknown — it can't mismatch.
  const servedRepo = cwdRepo === null ? null : repoIdentity(servedCwd);
  const mismatch = cwdRepo !== null && servedRepo !== null && cwdRepo !== servedRepo;
  return { cwdPrefix: null, servedPrefix: null, cwdRepo, servedRepo, mismatch, reason: mismatch ? "repo" : null };
}

/** The fail-closed write refusal for a cross-repo daemon write (by prefix or repo). */
export class WorkspaceAffinityError extends Error {
  readonly exitCode = 1;
  constructor(a: WorkspaceAffinity) {
    super(
      a.reason === "repo"
        ? `workspace-affinity refusal: this worktree's repo is "${a.cwdRepo}" but the daemon ` +
            `serves "${a.servedRepo}"'s beads — a write here would land in the wrong repo. cd to a ` +
            `"${a.servedRepo}" worktree, or point the daemon at this repo ` +
            `(PRX_BEADS_CWD=<clone> then restart beadsd).`
        : `workspace-affinity refusal: this worktree's bd prefix is "${a.cwdPrefix}" but the ` +
            `daemon serves "${a.servedPrefix}" — a write here would land in the wrong repo's ` +
            `beads. cd to a "${a.servedPrefix}" worktree, or point the daemon at the ` +
            `"${a.cwdPrefix}" clone (PRX_BEADS_CWD=<clone> then restart beadsd).`,
    );
    this.name = "WorkspaceAffinityError";
  }
}

/** The read-side warning (non-fatal): results come from a different repo's beads. */
export function workspaceAffinityWarning(opts: { cwdPrefix: string; servedPrefix: string }): string {
  return (
    `beads: warning — reading from a "${opts.cwdPrefix}" worktree but the daemon serves ` +
    `"${opts.servedPrefix}"; results are the "${opts.servedPrefix}" beads, not this repo's.`
  );
}

/**
 * Read-side affinity warning from the DAEMON-REPORTED served prefix (prx-9e86).
 * The daemon returns its served prefix on every reply, so the read path warns
 * with only a cheap cwd index read — no `bd config` subprocess (unlike
 * {@link resolveWorkspaceAffinity}, which the write path needs PRE-flight).
 * Returns the warning string on a definite mismatch, else null.
 */
export function readWorkspaceWarning(
  servedPrefix: string | undefined,
  deps: { cwd?: string; localPrefix?: (cwd: string) => string | null } = {},
): string | null {
  if (servedPrefix === undefined) return null;
  const cwd = deps.cwd ?? process.cwd();
  const cwdPrefix = (deps.localPrefix ?? localWorkspacePrefixForCwd)(cwd);
  if (cwdPrefix === null || cwdPrefix === servedPrefix) return null;
  return workspaceAffinityWarning({ cwdPrefix, servedPrefix });
}
