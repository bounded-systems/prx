/**
 * Narrow wrapper for `gh issue close` (intake-only).
 *
 * Mirrors `src/tools/gh_issue_create.ts`. Intentionally separate from
 * `src/tools/gh.ts` because:
 *   - `policy.ts` hard-blocks `gh:close` for every state×role combination
 *     (see `BLOCKED.gh`). The execGh gate cannot route close.
 *   - Closing a duplicate intake issue sits *upstream* of the parity chain —
 *     the dup never becomes a work unit, so it does not transition any state
 *     in the PR-lifecycle machine. Same justification as gh_issue_create.
 *
 * This wrapper is the single allowed surface for `gh issue close` from prx.
 * It is invoked by `prx intake merge` (GH-1001). Do not generalize this to a
 * full `gh issue` group wrapper — keep the surface narrow.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  recordGhResult,
} from "@bounded-systems/github-budget";

export type GhIssueCloseStateReason = "completed" | "not planned" | "duplicate";

export type GhIssueCloseResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Set when the rate-limit gate (GH-1141) refused or detected exhaustion.
   * Exit code is 1 and stderr carries a human-readable summary; downstream
   * fallback policy (T2/T3) consumes the typed structure here.
   */
  budgetError?: BucketBudgetExhaustedError;
};

export type GhIssueCloseOptions = {
  /** Issue number to close. */
  number: number;
  /** Maps to `gh issue close --reason`. Default `duplicate` for the dedupe path. */
  reason?: GhIssueCloseStateReason | undefined;
  /** Optional --repo OWNER/REPO; when omitted gh uses the cwd's git remote. */
  repo?: string | undefined;
  /** Working directory for the spawn — defaults to process.cwd(). */
  cwd?: string | undefined;
};

export type GhIssueCloseEnv = Record<string, string | undefined>;

export type GhIssueCloseSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type GhIssueCloseSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => GhIssueCloseSpawnResult;

/**
 * GH-1609: default spawn streams stdout through a per-call temp file via
 * `spawnCapture`, so a `gh issue close` body that grows past Node's default
 * 1 MiB stdout cap cannot ENOBUFS/SIGTERM the child and surface partial bytes
 * as the result. The injected-seam shape is unchanged so tests keep their
 * existing `GhIssueCloseSpawn` mocks.
 */
const defaultGhIssueCloseSpawn: GhIssueCloseSpawn = (file, args, options) => {
  const r = spawnCapture([file, ...args], {
    cwd: options.cwd,
    env: options.env,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
  };
};

/**
 * Build the `gh issue close` argv (without the leading `gh` binary).
 * Exposed for dry-run rendering and tests.
 */
export function buildGhIssueCloseArgs(opts: GhIssueCloseOptions): string[] {
  const args: string[] = ["issue", "close", String(opts.number)];
  const reason = opts.reason ?? "duplicate";
  args.push("--reason", reason);
  if (opts.repo) {
    args.push("--repo", opts.repo);
  }
  return args;
}

/**
 * Execute `gh issue close` with the given options. Returns the captured
 * stdout/stderr and exit code.
 */
export function execGhIssueClose(
  opts: GhIssueCloseOptions,
  env: GhIssueCloseEnv = processEnv(),
  spawn: GhIssueCloseSpawn = defaultGhIssueCloseSpawn,
): GhIssueCloseResult {
  const args = buildGhIssueCloseArgs(opts);
  const argv = ["gh", ...args];

  // Rate-limit gate (GH-1141)
  let gate: { bucket: "core" | "graphql" | "search"; remainingBefore: number | null } | null;
  try {
    gate = gateGhArgv(argv);
  } catch (err) {
    if (err instanceof BucketBudgetExhaustedError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gh-issue-close: ${err.message}`,
        budgetError: err,
      };
    }
    throw err;
  }

  const result = spawn("gh", args, {
    cwd: opts.cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const stderr =
    typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "");
  const exitCode = result.status ?? 1;

  if (gate) {
    try {
      recordGhResult(argv, gate.bucket, gate.remainingBefore, { stdout, stderr, status: exitCode });
    } catch (err) {
      if (err instanceof BucketBudgetExhaustedError) {
        return {
          exitCode,
          stdout,
          stderr: stderr || `gh-issue-close: ${err.message}`,
          budgetError: err,
        };
      }
      throw err;
    }
  }

  return { exitCode, stdout, stderr };
}

export function formatGhIssueCloseResult(
  result: GhIssueCloseResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.exitCode === 0) {
    return result.stdout.trimEnd();
  }
  const fallback = result.stderr || result.stdout;
  return fallback.trimEnd();
}
