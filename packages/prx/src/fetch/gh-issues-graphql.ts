// GH-1603 — native `gh api graphql` transport for the fetch verb.
//
// Replaces the dead `bd github sync --dry-run` heuristic (see
// docs/fetch-spike-retro.md §Q3): the shell-out probe's variance was
// >30% (§15 threshold) and 4/5 steady-state runs failed to parse
// (`BD_DRY_RUN_UNPARSEABLE`). Going native gives us:
//
//   • a cheap `totalCount` probe for the `--dry-run` cost projection
//     (I-F6); and
//   • authoritative per-call cost from the GraphQL response's
//     `rateLimit { cost remaining limit resetAt }` block on every page
//     of the live write loop.
//
// Both shapes are bracketed via `gateGhArgv` / `recordGhResult` (the
// existing GH-1141 bucket accounting) so the audit trail in
// `~/.cache/prx/github/rate-limit.jsonl` is identical to any other
// `gh api graphql` site in the codebase. The orchestrator
// (`runFetchGhIssues`) consumes the returned `RateLimitObservation` to
// account spent points per page.

import {
  BucketBudgetExhaustedError,
  gateGhArgv,
  parseRateLimitBlock,
  recordGhResult,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";
import { rawDefaultRunner } from "../pr-state/github.ts";
import type { CommandResult } from "../pr-state/github.ts";

/** Raw `gh` runner seam — tests inject a fake; production uses the un-gated spawn. */
export type GhRawRunner = (argv: string[]) => CommandResult;

export type GhGraphqlDeps = {
  /** Defaults to `rawDefaultRunner` (un-gated spawn — we bracket manually). */
  rawRunner?: GhRawRunner | undefined;
  /** Forwarded to `gateGhArgv` / `recordGhResult` for bucket accounting. */
  rateLimit?: RateLimitDeps | undefined;
};

export type RateLimitObservation = {
  /** GraphQL points the server charged for this query, or null when absent. */
  cost: number | null;
  remaining: number | null;
  limit: number | null;
  resetAtMs: number | null;
};

export class GhGraphqlError extends Error {
  readonly code: "GH_GRAPHQL_FAILED" | "GH_GRAPHQL_PARSE_FAILED";
  readonly stderr: string;
  constructor(message: string, code: "GH_GRAPHQL_FAILED" | "GH_GRAPHQL_PARSE_FAILED", stderr = "") {
    super(message);
    this.name = "GhGraphqlError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Minimal projection over a GH issue node — the fields the writer needs
 * to upsert via `bd update`. `state` is GitHub's enum (`OPEN`/`CLOSED`);
 * `updatedAt` is the ISO-8601 stamp used for both the page sort order
 * (`orderBy: { field: UPDATED_AT, direction: ASC }`) and the per-page
 * watermark advance (I-F5).
 */
export type GhIssueRow = {
  number: number;
  url: string;
  updatedAt: string;
  state: "OPEN" | "CLOSED";
  title: string;
};

export type ProbeResult = {
  totalCount: number;
  rateLimit: RateLimitObservation;
};

export type FetchPageOutput = {
  nodes: GhIssueRow[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  rateLimit: RateLimitObservation;
};

export type FetchPageOptions = {
  repo: string;
  since: string | null;
  pageSize?: number;
};

export type ProbeOptions = {
  repo: string;
  since: string | null;
};

// The `repository.issues(filterBy: { since })` field accepts a single
// DateTime filter — the v1 cut uses it as the watermark cursor. `since`
// is omitted (null) on the first run of a fresh substrate.
const COUNT_QUERY = `query FetchIssuesCount($owner: String!, $name: String!, $since: DateTime) {
  repository(owner: $owner, name: $name) {
    issues(filterBy: { since: $since }) {
      totalCount
    }
  }
  rateLimit { cost remaining limit resetAt }
}`;

// UPDATED_AT ASC means the last node of each page is the natural watermark
// advance point — no extra sort or scan needed (I-F5).
const PAGE_QUERY = `query FetchIssuesPage($owner: String!, $name: String!, $since: DateTime, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: ASC }, filterBy: { since: $since }) {
      pageInfo { hasNextPage endCursor }
      nodes { number url updatedAt state title }
    }
  }
  rateLimit { cost remaining limit resetAt }
}`;

function splitRepo(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new GhGraphqlError(
      `invalid repo \`${repo}\` (expected \`owner/name\`)`,
      "GH_GRAPHQL_PARSE_FAILED",
    );
  }
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

function buildArgv(query: string, fields: Record<string, string>): string[] {
  const args = ["gh", "api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(fields)) {
    args.push("-F", `${k}=${v}`);
  }
  return args;
}

function bracketGhCall(
  argv: string[],
  runner: GhRawRunner,
  rateLimit: RateLimitDeps | undefined,
): CommandResult {
  let gate: { bucket: "core" | "graphql" | "search"; remainingBefore: number | null } | null;
  try {
    gate = gateGhArgv(argv, rateLimit);
  } catch (err) {
    if (err instanceof BucketBudgetExhaustedError) {
      throw err;
    }
    throw err;
  }
  const result = runner(argv);
  if (gate) {
    recordGhResult(argv, gate.bucket, gate.remainingBefore, result, rateLimit);
  }
  return result;
}

function rateLimitFromResponse(stdout: string): RateLimitObservation {
  const block = parseRateLimitBlock(stdout);
  if (!block) {
    return { cost: null, remaining: null, limit: null, resetAtMs: null };
  }
  return {
    cost: block.cost,
    remaining: block.remaining,
    limit: block.limit,
    resetAtMs: block.resetAtMs,
  };
}

/**
 * Single cheap GraphQL probe returning the issue count under the same
 * `since` filter the live pagination will use. The probe answers "how
 * many points will this run cost?" without writing anything; the count
 * folds into `computeFetchPlan` as `corpusSize` (replaces the dead
 * `parseBdDryRunDelta` heuristic).
 */
export function probeCorpusCount(opts: ProbeOptions, deps: GhGraphqlDeps = {}): ProbeResult {
  const runner = deps.rawRunner ?? ((cmd: string[]) => rawDefaultRunner(cmd, { check: false }));
  const { owner, name } = splitRepo(opts.repo);

  const fields: Record<string, string> = { owner, name };
  if (opts.since !== null) fields.since = opts.since;

  const argv = buildArgv(COUNT_QUERY, fields);
  const result = bracketGhCall(argv, runner, deps.rateLimit);
  if (result.status !== 0) {
    throw new GhGraphqlError(
      `gh api graphql (count probe) failed (exit ${result.status})`,
      "GH_GRAPHQL_FAILED",
      result.stderr,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch (err) {
    throw new GhGraphqlError(
      `gh api graphql (count probe) returned non-JSON stdout: ${(err as Error).message}`,
      "GH_GRAPHQL_PARSE_FAILED",
      result.stderr,
    );
  }

  const totalCount = (body as { data?: { repository?: { issues?: { totalCount?: unknown } } } })
    ?.data?.repository?.issues?.totalCount;
  if (typeof totalCount !== "number" || !Number.isFinite(totalCount) || totalCount < 0) {
    throw new GhGraphqlError(
      `gh api graphql (count probe) missing data.repository.issues.totalCount`,
      "GH_GRAPHQL_PARSE_FAILED",
      result.stderr,
    );
  }

  return {
    totalCount: Math.floor(totalCount),
    rateLimit: rateLimitFromResponse(result.stdout),
  };
}

/**
 * Fetch one page of issues ordered by `UPDATED_AT ASC`. Caller threads
 * `cursor` from the previous page's `pageInfo.endCursor` (null for the
 * first page). The last node's `updatedAt` is the natural watermark
 * advance point — caller is expected to read it off `nodes[len-1]` after
 * a successful write.
 */
export function fetchIssuesPage(
  cursor: string | null,
  opts: FetchPageOptions,
  deps: GhGraphqlDeps = {},
): FetchPageOutput {
  const runner = deps.rawRunner ?? ((cmd: string[]) => rawDefaultRunner(cmd, { check: false }));
  const { owner, name } = splitRepo(opts.repo);
  const pageSize = opts.pageSize ?? 100;

  const fields: Record<string, string> = {
    owner,
    name,
    first: String(pageSize),
  };
  if (opts.since !== null) fields.since = opts.since;
  if (cursor !== null) fields.cursor = cursor;

  const argv = buildArgv(PAGE_QUERY, fields);
  const result = bracketGhCall(argv, runner, deps.rateLimit);
  if (result.status !== 0) {
    throw new GhGraphqlError(
      `gh api graphql (page fetch) failed (exit ${result.status})`,
      "GH_GRAPHQL_FAILED",
      result.stderr,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch (err) {
    throw new GhGraphqlError(
      `gh api graphql (page fetch) returned non-JSON stdout: ${(err as Error).message}`,
      "GH_GRAPHQL_PARSE_FAILED",
      result.stderr,
    );
  }

  const issues = (
    body as {
      data?: {
        repository?: {
          issues?: {
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            nodes?: unknown;
          };
        };
      };
    }
  )?.data?.repository?.issues;

  if (!issues || !Array.isArray(issues.nodes)) {
    throw new GhGraphqlError(
      `gh api graphql (page fetch) missing data.repository.issues.nodes`,
      "GH_GRAPHQL_PARSE_FAILED",
      result.stderr,
    );
  }

  const nodes: GhIssueRow[] = [];
  for (const raw of issues.nodes as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.number !== "number" ||
      typeof r.url !== "string" ||
      typeof r.updatedAt !== "string" ||
      typeof r.title !== "string"
    ) {
      throw new GhGraphqlError(
        `gh api graphql (page fetch) node missing required fields`,
        "GH_GRAPHQL_PARSE_FAILED",
        result.stderr,
      );
    }
    const state = r.state === "OPEN" || r.state === "CLOSED" ? r.state : "OPEN";
    nodes.push({
      number: r.number,
      url: r.url,
      updatedAt: r.updatedAt,
      state,
      title: r.title,
    });
  }

  const pageInfo = issues.pageInfo ?? {};
  return {
    nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage === true,
      endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    },
    rateLimit: rateLimitFromResponse(result.stdout),
  };
}
