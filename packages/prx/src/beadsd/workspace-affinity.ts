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
import { localWorkspacePrefixForCwd } from "../pr-state/repos.ts";
import { resolveLocalBeadsCwd } from "./client-factory.ts";

export interface WorkspaceAffinity {
  /** The cwd repo's bd prefix (from the repo inventory), or null if unknown. */
  cwdPrefix: string | null;
  /** The served clone's bd prefix (`bd config get issue_prefix`), or null. */
  servedPrefix: string | null;
  /** True ONLY when both prefixes are known and differ — the cross-repo case. */
  mismatch: boolean;
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
}

/**
 * Resolve the cwd vs served-clone prefix relationship. The served prefix (a bd
 * subprocess) is only read when the cwd prefix is known — a null cwd prefix can
 * never be a definite mismatch, so the expensive lookup is skipped.
 */
export function resolveWorkspaceAffinity(deps: WorkspaceAffinityDeps = {}): WorkspaceAffinity {
  const cwd = deps.cwd ?? process.cwd();
  const localPrefix = deps.localPrefix ?? localWorkspacePrefixForCwd;
  const cwdPrefix = localPrefix(cwd);
  if (cwdPrefix === null) {
    return { cwdPrefix: null, servedPrefix: null, mismatch: false };
  }
  const servedCwd = deps.servedCwd ?? resolveLocalBeadsCwd();
  const servedPrefix = (deps.servedPrefix ?? ((s) => diagnoseBeads({ cwd: s }).prefix))(servedCwd);
  return { cwdPrefix, servedPrefix, mismatch: servedPrefix !== null && cwdPrefix !== servedPrefix };
}

/** The fail-closed write refusal for a cross-repo daemon write. */
export class WorkspaceAffinityError extends Error {
  readonly cwdPrefix: string;
  readonly servedPrefix: string;
  readonly exitCode = 1;
  constructor(opts: { cwdPrefix: string; servedPrefix: string }) {
    super(
      `workspace-affinity refusal: this worktree's bd prefix is "${opts.cwdPrefix}" but the ` +
        `daemon serves "${opts.servedPrefix}" — a write here would land in the wrong repo's ` +
        `beads. cd to a "${opts.servedPrefix}" worktree, or point the daemon at the ` +
        `"${opts.cwdPrefix}" clone (PRX_BEADS_CWD=<clone> then restart beadsd).`,
    );
    this.name = "WorkspaceAffinityError";
    this.cwdPrefix = opts.cwdPrefix;
    this.servedPrefix = opts.servedPrefix;
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
