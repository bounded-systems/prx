/**
 * Git tool — typed interface for git operations.
 *
 * Wraps CommandRunner with git-specific operations and policy enforcement.
 * Used by:
 *   - `prx tools git exec` (CLI entry point, replaces scripts/git-safe)
 *   - Internal callers in src/pr-state/github.ts (direct function calls)
 */

import { processEnv } from "@bounded-systems/env";
import {
  captureFailureDetail,
  isCaptureFailure,
  spawnCapture,
} from "@bounded-systems/proc";
import {
  checkPolicy,
  isBlocked,
  type PolicyState,
  type PolicyRole,
  type PolicyDecision,
} from "@bounded-systems/policy";

import { runWithGitLockRecovery } from "./lock.ts";

export {
  recoverStaleLock,
  runWithGitLockRecovery,
  withGitLockRecovery,
  parseLockPath,
  isRetryableGitLock,
  DEFAULT_STALE_AGE_MS,
  type LockRecovery,
  type LockRecoveryDeps,
  type LockRecoveryHooks,
  type LockStat,
} from "./lock.ts";

export type GitExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  policy: PolicyDecision | null;
};

export type GitExecOptions = {
  subcommand: string;
  args: string[];
  cwd?: string | undefined;
  /** If set, enforce policy before executing. */
  state?: PolicyState | undefined;
  role?: PolicyRole | undefined;
};

export type GitExecEnv = {
  PRX_CAPABILITY_STATE?: string;
  PRX_AGENT_ROLE?: string;
  [key: string]: string | undefined;
};

const ALLOWED_SUBCOMMANDS = [
  "status", "diff", "log", "show", "rev-parse", "branch", "worktree",
  "fetch", "add", "commit", "restore", "switch", "checkout", "merge", "pull", "push",
  // GH-2381: object-graph materializers — gated to role=keeper by POLICY_TABLE.
  "write-tree", "commit-tree",
  // GH-201: local object export for the isolated keeper (keeperd). `bundle`
  // packs a commit range into a file so the host can ship objects to the in-VM
  // keeper, which imports them via `fetch` (already allowed) and does the signed
  // push. Read-only + local (no ref mutation, no network); gated to role=keeper.
  "bundle",
] as const;

/**
 * Execute a git subcommand with optional policy enforcement.
 */
export function execGit(opts: GitExecOptions, env: GitExecEnv = processEnv()): GitExecResult {
  // Hard-block check
  if (isBlocked("git", opts.subcommand)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `git-safe: blocked subcommand '${opts.subcommand}'`,
      policy: null,
    };
  }

  // Allowlist check
  if (!(ALLOWED_SUBCOMMANDS as readonly string[]).includes(opts.subcommand)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `git-safe: unknown or disallowed subcommand '${opts.subcommand}'`,
      policy: null,
    };
  }

  // Policy enforcement
  const state = opts.state ?? (env.PRX_CAPABILITY_STATE as PolicyState | undefined) ?? "validating";
  const role = opts.role ?? (env.PRX_AGENT_ROLE as PolicyRole | undefined) ?? "executor";
  const decision = checkPolicy("git", opts.subcommand, state, role);

  if (!decision.allowed) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `git-safe: blocked subcommand '${opts.subcommand}' for state '${state}' role '${role}'`,
      policy: decision,
    };
  }

  // Execute — GH-1609: stream stdout through spawnCapture so `git log -p`,
  // `git diff`, and similar large reads cannot hit the default 1 MiB stdout cap.
  // ai-home-bbdm1: a lock-contention failure (stale index.lock from a crashed
  // sibling) triggers a single safe-guarded stale-lock recovery + retry.
  // GH-388/GH-360: headless-safe signing. prx's provenance signing is ed25519
  // over the chain (keeper's commit-tree), NEVER git's gpg/ssh commit signing —
  // which is the OPERATOR's config and fails in non-interactive/agent contexts
  // (e.g. 1Password SSH: "agent returned an error" → "failed to write commit
  // object"). Disable commit/tag signing at this single git seam so every prx
  // caller (keeper, `prx tools git`, the executor leg) is robust regardless of
  // the operator's commit.gpgsign.
  const signingOff =
    opts.subcommand === "commit"
      ? ["-c", "commit.gpgsign=false"]
      : opts.subcommand === "tag"
        ? ["-c", "tag.gpgsign=false"]
        : [];
  const result = runWithGitLockRecovery(() =>
    spawnCapture(
      ["git", "-C", opts.cwd ?? process.cwd(), ...signingOff, opts.subcommand, ...opts.args],
      { env: env as Record<string, string> },
    ),
  );

  if (isCaptureFailure(result)) {
    return {
      exitCode: result.status ?? 1,
      stdout: "",
      stderr: `git-safe: ${captureFailureDetail(result) || "git failed"}`,
      policy: decision,
    };
  }

  return {
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    policy: decision,
  };
}

export function formatGitExecResult(result: GitExecResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  // Plain: just pass through stdout/stderr like native git
  let output = result.stdout;
  if (result.stderr && result.exitCode !== 0) {
    output = result.stderr;
  }
  return output.trimEnd();
}
