/**
 * Narrow wrapper for `gh pr view --json …` (submit-only).
 *
 * Mirrors `src/tools/gh_issue_close.ts`. PR-view is a *read*, so it could
 * route through `execGh`, but `prx submit postmerge` is the only caller
 * today and the audit boundary is cleaner with a dedicated wrapper:
 *   - Single, narrowly-scoped argv builder for tests + dry-run rendering.
 *   - Same rate-limit-gate / spawnCapture seam as `gh_issue_close`.
 *   - One module to grep when extending the postmerge JSON projection.
 *
 * Do not generalize to a full `gh pr` group wrapper — keep the surface
 * narrow. The `execGh` group wrapper (`src/tools/gh.ts`) is the canonical
 * surface for arbitrary `gh pr <verb>` reads.
 *
 * GH CLI deprecation: `merged` is no longer a valid `--json` field; use
 * `state` (gate on `=== "MERGED"`) and `mergedAt` (observability) instead.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  recordGhResult,
} from "@bounded-systems/github-budget";

/**
 * Fields the postmerge sweep needs. `closingIssuesReferences` is the
 * GitHub-resolved set of issues that were auto-closed at merge time
 * (`Closes #N` / `Fixes #N` / `Resolves #N` in the title or body); the
 * sweep subtracts these from the extracted ref set before closing.
 */
export const GH_PR_VIEW_JSON_FIELDS = [
  "body",
  "title",
  "number",
  "state",
  "mergedAt",
  "mergeCommit",
  "closingIssuesReferences",
] as const;

export type GhPrViewClosingIssueReference = {
  number: number;
};

export type GhPrViewState = "OPEN" | "CLOSED" | "MERGED";

export type GhPrViewJson = {
  body: string;
  title: string;
  number: number;
  state: GhPrViewState;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  closingIssuesReferences: GhPrViewClosingIssueReference[];
};

export type GhPrViewResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  budgetError?: BucketBudgetExhaustedError;
};

export type GhPrViewOptions = {
  number: number;
  repo?: string | undefined;
  cwd?: string | undefined;
};

export type GhPrViewEnv = Record<string, string | undefined>;

export type GhPrViewSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type GhPrViewSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => GhPrViewSpawnResult;

const defaultGhPrViewSpawn: GhPrViewSpawn = (file, args, options) => {
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

export function buildGhPrViewArgs(opts: GhPrViewOptions): string[] {
  const args: string[] = [
    "pr",
    "view",
    String(opts.number),
    "--json",
    GH_PR_VIEW_JSON_FIELDS.join(","),
  ];
  if (opts.repo) {
    args.push("--repo", opts.repo);
  }
  return args;
}

export function execGhPrView(
  opts: GhPrViewOptions,
  env: GhPrViewEnv = processEnv(),
  spawn: GhPrViewSpawn = defaultGhPrViewSpawn,
): GhPrViewResult {
  const args = buildGhPrViewArgs(opts);
  const argv = ["gh", ...args];

  let gate: { bucket: "core" | "graphql" | "search"; remainingBefore: number | null } | null;
  try {
    gate = gateGhArgv(argv);
  } catch (err) {
    if (err instanceof BucketBudgetExhaustedError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gh-pr-view: ${err.message}`,
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
          stderr: stderr || `gh-pr-view: ${err.message}`,
          budgetError: err,
        };
      }
      throw err;
    }
  }

  return { exitCode, stdout, stderr };
}

export function parseGhPrViewJson(stdout: string): GhPrViewJson | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const number = typeof obj.number === "number" ? obj.number : null;
  const stateRaw = typeof obj.state === "string" ? obj.state : null;
  const state: GhPrViewState | null =
    stateRaw === "OPEN" || stateRaw === "CLOSED" || stateRaw === "MERGED"
      ? stateRaw
      : null;
  const mergedAt =
    typeof obj.mergedAt === "string"
      ? obj.mergedAt
      : obj.mergedAt === null || obj.mergedAt === undefined
        ? null
        : null;
  const body = typeof obj.body === "string" ? obj.body : "";
  const title = typeof obj.title === "string" ? obj.title : "";
  if (number === null || state === null) return null;

  let mergeCommit: { oid: string } | null = null;
  if (obj.mergeCommit && typeof obj.mergeCommit === "object") {
    const oid = (obj.mergeCommit as { oid?: unknown }).oid;
    if (typeof oid === "string") mergeCommit = { oid };
  }

  const closingIssuesReferences: GhPrViewClosingIssueReference[] = [];
  if (Array.isArray(obj.closingIssuesReferences)) {
    for (const ref of obj.closingIssuesReferences) {
      if (ref && typeof ref === "object") {
        const n = (ref as { number?: unknown }).number;
        if (typeof n === "number") {
          closingIssuesReferences.push({ number: n });
        }
      }
    }
  }

  return {
    body,
    title,
    number,
    state,
    mergedAt,
    mergeCommit,
    closingIssuesReferences,
  };
}
