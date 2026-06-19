/**
 * GitHub CLI tool — typed interface for gh operations.
 *
 * Wraps CommandRunner with gh-specific operations and policy enforcement.
 * GH-874 hard-removed the `prx tools gh` CLI entry point; this module is now
 * called only by internal verbs (`prx scout`, `prx doctor`, `prx intake view`,
 * `prx beads publish`, `prx triage`, etc.) via direct `execGh()` calls.
 *
 * Allowed groups: `pr`, `issue` (issue group added for `prx triage apply`,
 * GH-919). Each group has its own per-subcommand allowlist; both share the
 * same `gh:<state>:<role>` policy table (the policy layer is group-agnostic).
 */

import { processEnv } from "@bounded-systems/env";
import {
  captureFailureDetail,
  isCaptureFailure,
  runCaptured,
  spawnCapture,
  type CommandResult,
  type SpawnCaptureResult,
} from "@bounded-systems/proc";
import {
  checkPolicy,
  isBlocked,
  type PolicyState,
  type PolicyRole,
  type PolicyDecision,
} from "@bounded-systems/policy";
import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  recordGhResult,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";

export type GhExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  policy: PolicyDecision | null;
  /**
   * Set when the rate-limit gate (GH-1141) refused or detected exhaustion.
   * Exit code is 1 and stderr carries a human-readable summary; downstream
   * fallback policy (T2/T3) consumes the typed structure here.
   */
  budgetError?: BucketBudgetExhaustedError;
};

export type GhExecOptions = {
  /** The gh command group (`pr` or `issue`). */
  group: string;
  subcommand: string;
  args: string[];
  /** If set, enforce policy before executing. */
  state?: PolicyState;
  role?: PolicyRole;
};

/**
 * Injectable seams for `execGh`. All optional and default to the production
 * implementations, so callers pass nothing and behavior is unchanged. They
 * exist so the rate-limit authority boundary (the gate + post-call recorder)
 * is exercisable without a live `gh` spawn or real GitHub budget state.
 */
export type GhExecDeps = {
  /** The gh spawn. Defaults to the real {@link spawnCapture}. */
  spawn?: (cmd: string[], options: { env: Record<string, string> }) => SpawnCaptureResult;
  /** Rate-limit gate deps. Defaults (via `undefined`) to the configured budget. */
  budget?: RateLimitDeps;
};

const ALLOWED_GROUPS = ["pr", "issue"] as const;
type AllowedGroup = (typeof ALLOWED_GROUPS)[number];

export type GhExecEnv = {
  PRX_CAPABILITY_STATE?: string;
  PRX_AGENT_ROLE?: string;
  [key: string]: string | undefined;
};

const ALLOWED_PR_SUBCOMMANDS = [
  "status",
  "list",
  "view",
  "checks",
  "diff",
  "comment",
  "create",
  "edit",
  "ready",
  "review",
] as const;

// `comment` is needed by `prx triage promote` (GH-936) so the verb can post the
// `Promoted to beads as <bd-id>.` pointer back to the GH issue. `create` is
// needed by `prx beads publish` (GH-1507) so the verb can mirror reverse-orphan
// beads into fresh GH issues. The `gh:*:executor` policy table already permits
// `comment` and `create`, so this allowlist extension is the only gate.
const ALLOWED_ISSUE_SUBCOMMANDS = ["list", "view", "edit", "comment", "create"] as const;

const GROUP_ALLOWLISTS: Record<AllowedGroup, readonly string[]> = {
  pr: ALLOWED_PR_SUBCOMMANDS,
  issue: ALLOWED_ISSUE_SUBCOMMANDS,
};

/**
 * Execute a gh subcommand with optional policy enforcement.
 */
export function execGh(
  opts: GhExecOptions,
  env: GhExecEnv = processEnv(),
  deps: GhExecDeps = {},
): GhExecResult {
  // Group check — only allowed groups are accepted
  if (!(ALLOWED_GROUPS as readonly string[]).includes(opts.group)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gh-safe: only ${ALLOWED_GROUPS.join("/")} groups are allowed, got '${opts.group}'`,
      policy: null,
    };
  }
  const group = opts.group as AllowedGroup;

  // Hard-block check
  if (isBlocked("gh", opts.subcommand)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gh-safe: blocked ${group} subcommand '${opts.subcommand}'`,
      policy: null,
    };
  }

  // Per-group allowlist check
  if (!GROUP_ALLOWLISTS[group].includes(opts.subcommand)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gh-safe: unknown or disallowed ${group} subcommand '${opts.subcommand}'`,
      policy: null,
    };
  }

  // Policy enforcement
  const state = opts.state ?? (env.PRX_CAPABILITY_STATE as PolicyState | undefined) ?? "validating";
  const role = opts.role ?? (env.PRX_AGENT_ROLE as PolicyRole | undefined) ?? "executor";
  const decision = checkPolicy("gh", opts.subcommand, state, role);

  if (!decision.allowed) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gh-safe: blocked ${group} subcommand '${opts.subcommand}' for state '${state}' role '${role}'`,
      policy: decision,
    };
  }

  // Rate-limit gate (GH-1141)
  const argv = ["gh", group, opts.subcommand, ...opts.args];
  let gate: { bucket: "core" | "graphql" | "search"; remainingBefore: number | null } | null;
  try {
    gate = gateGhArgv(argv, deps.budget);
  } catch (err) {
    if (err instanceof BucketBudgetExhaustedError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gh-safe: ${err.message}`,
        policy: decision,
        budgetError: err,
      };
    }
    throw err;
  }

  // Execute — GH-1609: route through spawnCapture so large `gh api` payloads
  // cannot hit the default 1 MiB stdout cap. Apply the GH-1554 partial-read
  // guard before recordGhResult sees the result.
  const captured = (deps.spawn ?? spawnCapture)(["gh", group, opts.subcommand, ...opts.args], {
    env: env as Record<string, string>,
  });
  // A null status means a signal kill or spawn error (always a capture
  // failure), which maps to exit 1; a clean capture always carries status 0.
  // So the same `?? 1` is exact in both arms — the success arm never sees null
  // (see isCaptureFailure) — and there is no dead per-arm fallback.
  const status = captured.status ?? 1;
  const cmdResult = isCaptureFailure(captured)
    ? {
        stdout: "",
        stderr: `gh-safe: ${captureFailureDetail(captured) || "gh failed"}`,
        status,
      }
    : { stdout: captured.stdout, stderr: captured.stderr, status };

  if (gate) {
    try {
      recordGhResult(argv, gate.bucket, gate.remainingBefore, cmdResult, deps.budget);
    } catch (err) {
      if (err instanceof BucketBudgetExhaustedError) {
        return {
          exitCode: cmdResult.status,
          stdout: cmdResult.stdout,
          stderr: cmdResult.stderr || `gh-safe: ${err.message}`,
          policy: decision,
          budgetError: err,
        };
      }
      throw err;
    }
  }

  return {
    exitCode: cmdResult.status,
    stdout: cmdResult.stdout,
    stderr: cmdResult.stderr,
    policy: decision,
  };
}

/** Raw `gh` runner seam — tests inject a fake; production uses runCaptured. */
export type GhRawRunner = (argv: string[]) => CommandResult;

export type FetchIssueLabelsDeps = {
  /** Defaults to `runCaptured` with `check: false`. */
  rawRunner?: GhRawRunner;
};

/**
 * GH-1866 — fetch live GH labels for a batch of issue numbers via a single
 * aliased `gh api graphql` query. Returns a Map keyed by issue number whose
 * value is the live `labels.nodes[].name` array.
 *
 * Throws on non-zero gh exit, unparseable JSON, a populated `errors[]` field,
 * or a missing alias entry. `runTriageApply` consumes this fail-closed: any
 * failure aborts the apply pass without writing labels, because falling back
 * to the bd-cache `currentLabels` snapshot would silently re-enable the
 * stale-bd-vs-fresh-GH stacking bug this fix is meant to repair.
 *
 * Label arrays beyond 50 entries emit a warning to stderr and fall through;
 * none of our issues approach that ceiling today.
 */
export function fetchIssueLabels(
  repo: string,
  numbers: readonly number[],
  deps: FetchIssueLabelsDeps = {},
): Map<number, string[]> {
  if (numbers.length === 0) return new Map();
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new Error(`fetchIssueLabels: invalid repo \`${repo}\` (expected \`owner/name\`)`);
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);

  const aliasLines = numbers.map(
    (n) =>
      `i${n}: issue(number: ${n}) { labels(first: 50) { nodes { name } pageInfo { hasNextPage } } }`,
  );
  const query = `query FetchIssueLabels($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${aliasLines.map((l) => `    ${l}`).join("\n")}
  }
}`;

  const argv = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
  ];
  const runner = deps.rawRunner ?? ((cmd: string[]) => runCaptured(cmd, { check: false }));
  const result = runner(argv);
  if (result.status !== 0) {
    throw new Error(
      `fetchIssueLabels: gh api graphql failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`fetchIssueLabels: non-JSON stdout: ${(err as Error).message}`);
  }
  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`fetchIssueLabels: GraphQL errors: ${JSON.stringify(errors)}`);
  }
  const repoBlock = (body as { data?: { repository?: Record<string, unknown> } }).data?.repository;
  if (!repoBlock || typeof repoBlock !== "object") {
    throw new Error(`fetchIssueLabels: missing data.repository in response`);
  }

  const out = new Map<number, string[]>();
  for (const n of numbers) {
    const alias = repoBlock[`i${n}`];
    if (!alias || typeof alias !== "object") {
      throw new Error(`fetchIssueLabels: missing alias i${n} in response`);
    }
    const labels = (alias as { labels?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } })
      .labels;
    if (!labels || !Array.isArray(labels.nodes)) {
      throw new Error(`fetchIssueLabels: missing labels.nodes for issue ${n}`);
    }
    if (labels.pageInfo?.hasNextPage === true) {
      process.stderr.write(`fetchIssueLabels: issue ${n} has >50 labels; truncating to first 50\n`);
    }
    const names: string[] = [];
    for (const node of labels.nodes as unknown[]) {
      if (
        node &&
        typeof node === "object" &&
        typeof (node as { name?: unknown }).name === "string"
      ) {
        names.push((node as { name: string }).name);
      }
    }
    out.set(n, names);
  }
  return out;
}

export function formatGhExecResult(result: GhExecResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  let output = result.stdout;
  if (result.stderr && result.exitCode !== 0) {
    output = result.stderr;
  }
  return output.trimEnd();
}
