/**
 * Narrow wrapper for `gh issue create` (intake-only).
 *
 * Intentionally separate from src/tools/gh.ts:
 *   - gh.ts is locked to the `pr` group and gates every subcommand through the
 *     planning/validating/merging × planner/executor/reviewer/tester policy
 *     table in tools/policy.ts. That table is built around PR-lifecycle
 *     transitions for an existing work unit.
 *   - Issue *creation* is upstream intake — it filings a new GH issue *before*
 *     a unit exists. It does not transition the parity chain or any state in
 *     the PR-lifecycle machine, so it sits outside the policy table by design.
 *
 * This wrapper is the single allowed surface for `gh issue create` from prx.
 * It is invoked by `prx intake <type>` (GH-666). Do not generalize this to a
 * full `gh issue` group wrapper — keep the surface narrow.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  recordGhResult,
} from "@bounded-systems/github-budget";

export type GhIssueCreateResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Extracted GH issue URL when gh exits 0; null on failure or unparseable output. */
  issueUrl: string | null;
  /**
   * Set when the rate-limit gate (GH-1141) refused or detected exhaustion.
   * Exit code is 1 and stderr carries a human-readable summary; downstream
   * fallback policy (T2/T3) consumes the typed structure here.
   */
  budgetError?: BucketBudgetExhaustedError;
};

export type GhIssueCreateOptions = {
  title: string;
  body?: string;
  /** Optional --repo OWNER/REPO; when omitted gh uses the cwd's git remote. */
  repo?: string;
  labels?: readonly string[];
  assignees?: readonly string[];
  /** Working directory for the spawn — defaults to process.cwd(). */
  cwd?: string;
};

export type GhIssueCreateEnv = Record<string, string | undefined>;

export type GhIssueCreateSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type GhIssueCreateSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => GhIssueCreateSpawnResult;

/**
 * GH-1609: default spawn streams stdout via `spawnCapture` so `gh issue create`
 * (which echoes the new issue URL on a tiny stdout in practice, but isn't
 * structurally bounded) cannot hit Node's default 1 MiB stdout cap. The
 * injected-seam shape is unchanged so tests keep their existing mocks.
 */
const defaultGhIssueCreateSpawn: GhIssueCreateSpawn = (file, args, options) => {
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
 * Build the `gh issue create` argv (without the leading `gh` binary).
 * Exposed for dry-run rendering and tests.
 */
export function buildGhIssueCreateArgs(opts: GhIssueCreateOptions): string[] {
  const args: string[] = ["issue", "create", "--title", opts.title];
  if (opts.body !== undefined) {
    args.push("--body", opts.body);
  }
  if (opts.repo) {
    args.push("--repo", opts.repo);
  }
  for (const label of opts.labels ?? []) {
    args.push("--label", label);
  }
  for (const assignee of opts.assignees ?? []) {
    args.push("--assignee", assignee);
  }
  return args;
}

/**
 * gh prints the created issue URL on the last non-empty stdout line. Extract it
 * defensively so output containing notices ("Creating issue in owner/repo")
 * doesn't trip the parser.
 */
export function extractIssueUrl(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const lastLine = trimmed.split(/\r?\n/).pop()?.trim() ?? "";
  const lastLineMatch = lastLine.match(/^https?:\/\/\S+\/issues\/\d+\b/);
  if (lastLineMatch) {
    return lastLineMatch[0];
  }
  const match = trimmed.match(/https?:\/\/\S+\/issues\/\d+/);
  return match ? match[0] : null;
}

/**
 * Execute `gh issue create` with the given options. Returns the captured
 * stdout/stderr, exit code, and parsed issue URL.
 */
export function execGhIssueCreate(
  opts: GhIssueCreateOptions,
  env: GhIssueCreateEnv = processEnv(),
  spawn: GhIssueCreateSpawn = defaultGhIssueCreateSpawn,
): GhIssueCreateResult {
  const args = buildGhIssueCreateArgs(opts);
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
        stderr: `gh-issue-create: ${err.message}`,
        issueUrl: null,
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
  const stdout = typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const stderr = typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "");
  const exitCode = result.status ?? 1;

  if (gate) {
    try {
      recordGhResult(argv, gate.bucket, gate.remainingBefore, { stdout, stderr, status: exitCode });
    } catch (err) {
      if (err instanceof BucketBudgetExhaustedError) {
        return {
          exitCode,
          stdout,
          stderr: stderr || `gh-issue-create: ${err.message}`,
          issueUrl: null,
          budgetError: err,
        };
      }
      throw err;
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    issueUrl: exitCode === 0 ? extractIssueUrl(stdout) : null,
  };
}

export function formatGhIssueCreateResult(
  result: GhIssueCreateResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.exitCode === 0 && result.issueUrl) {
    return result.issueUrl;
  }
  const fallback = result.stderr || result.stdout;
  return fallback.trimEnd();
}
