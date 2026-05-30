/**
 * Narrow wrapper for `gh issue edit` (the bd→GH issue-mutation chokepoint).
 *
 * Mirrors `src/tools/gh_issue_create.ts` / `gh_issue_close.ts`. Intentionally
 * separate from `src/tools/gh.ts` because that gate is locked to the `pr` group
 * and the PR-lifecycle policy table — issue *editing* is the bd→external mirror
 * write (GH-2382), not a PR-lifecycle transition.
 *
 * GH-2382 makes this the single allowed surface for `gh issue edit` from prx:
 * the `GhDomainAdapter.push` linked path routes its lossless title/body/label/
 * assignee edit through here, and the `publisher issueUpdate` verb wraps it with
 * the `ISSUE_UPDATE_REQUESTED` intent so every bd→GH issue edit has one home and
 * one audit attribution. The `test/policy/no-raw-gh-issue-edit.test.ts` guard
 * forbids re-introducing a raw `gh issue edit` invocation elsewhere.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  recordGhResult,
} from "@bounded-systems/github-budget";

export type GhIssueEditResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Set when the rate-limit gate (GH-1141) refused or detected exhaustion.
   * Exit code is 1 and stderr carries a human-readable summary; downstream
   * fallback policy consumes the typed structure here.
   */
  budgetError?: BucketBudgetExhaustedError;
};

export type GhIssueEditOptions = {
  /** Issue number to edit. */
  number: number;
  /** Optional --repo OWNER/REPO; when omitted gh uses the cwd's git remote. */
  repo?: string | undefined;
  /** New title (maps to `--title`). Omit to leave unchanged. */
  title?: string | undefined;
  /** New body (maps to `--body`). Omit to leave unchanged. */
  body?: string | undefined;
  /** Labels to add (`--add-label`, comma-joined). */
  addLabels?: readonly string[] | undefined;
  /** Labels to remove (`--remove-label`, comma-joined). */
  removeLabels?: readonly string[] | undefined;
  /** Assignees to add (`--add-assignee`, one flag per login). */
  addAssignees?: readonly string[] | undefined;
  /** Assignees to remove (`--remove-assignee`, one flag per login). */
  removeAssignees?: readonly string[] | undefined;
  /** Working directory for the spawn — defaults to process.cwd(). */
  cwd?: string | undefined;
};

export type GhIssueEditEnv = Record<string, string | undefined>;

export type GhIssueEditSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type GhIssueEditSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => GhIssueEditSpawnResult;

const defaultGhIssueEditSpawn: GhIssueEditSpawn = (file, args, options) => {
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
 * Build the `gh issue edit` argv (without the leading `gh` binary). Exposed for
 * dry-run rendering and tests. Returns the bare `["issue","edit",N]` when no
 * mutating flag was requested — callers should gate on `hasGhIssueEdit` before
 * invoking so an empty edit is never spawned.
 */
export function buildGhIssueEditArgs(opts: GhIssueEditOptions): string[] {
  const args: string[] = ["issue", "edit", String(opts.number)];
  if (typeof opts.title === "string") args.push("--title", opts.title);
  if (typeof opts.body === "string") args.push("--body", opts.body);
  const addLabels = (opts.addLabels ?? []).filter((l) => l.length > 0);
  if (addLabels.length > 0) args.push("--add-label", addLabels.join(","));
  const removeLabels = (opts.removeLabels ?? []).filter((l) => l.length > 0);
  if (removeLabels.length > 0) args.push("--remove-label", removeLabels.join(","));
  for (const login of opts.addAssignees ?? []) {
    if (login.length > 0) args.push("--add-assignee", login);
  }
  for (const login of opts.removeAssignees ?? []) {
    if (login.length > 0) args.push("--remove-assignee", login);
  }
  if (opts.repo) args.push("--repo", opts.repo);
  return args;
}

/** True when `opts` carries at least one mutating flag (vs a bare no-op edit). */
export function hasGhIssueEdit(opts: GhIssueEditOptions): boolean {
  return (
    typeof opts.title === "string" ||
    typeof opts.body === "string" ||
    (opts.addLabels ?? []).some((l) => l.length > 0) ||
    (opts.removeLabels ?? []).some((l) => l.length > 0) ||
    (opts.addAssignees ?? []).some((l) => l.length > 0) ||
    (opts.removeAssignees ?? []).some((l) => l.length > 0)
  );
}

/**
 * Execute `gh issue edit` with the given options. Returns the captured
 * stdout/stderr and exit code. Rate-limit gated (GH-1141).
 */
export function execGhIssueEdit(
  opts: GhIssueEditOptions,
  env: GhIssueEditEnv = processEnv(),
  spawn: GhIssueEditSpawn = defaultGhIssueEditSpawn,
): GhIssueEditResult {
  const args = buildGhIssueEditArgs(opts);
  const argv = ["gh", ...args];

  let gate: { bucket: "core" | "graphql" | "search"; remainingBefore: number | null } | null;
  try {
    gate = gateGhArgv(argv);
  } catch (err) {
    if (err instanceof BucketBudgetExhaustedError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gh-issue-edit: ${err.message}`,
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
          stderr: stderr || `gh-issue-edit: ${err.message}`,
          budgetError: err,
        };
      }
      throw err;
    }
  }

  return { exitCode, stdout, stderr };
}

export function formatGhIssueEditResult(
  result: GhIssueEditResult,
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
