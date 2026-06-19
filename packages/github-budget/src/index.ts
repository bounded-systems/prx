/**
 * Rate-limit-aware wrapper for `gh` CLI invocations (GH-1141).
 *
 * GitHub enforces bucket isolation: REST `core` and `graphql` are independent
 * 5000-unit pools, and `gh ... --json` silently routes through GraphQL even
 * for "list" operations. The wrapper here:
 *
 *   1. classifies each invocation by argv into one of three buckets
 *      (`core` | `graphql` | `search`),
 *   2. gates the call against a cached `gh api rate_limit` snapshot — when
 *      `remaining < threshold` the call short-circuits with a typed
 *      `<Bucket>BudgetExhaustedError` before spawning,
 *   3. parses obvious throttling signals out of stderr post-call so the
 *      cache stays honest, and
 *   4. emits one JSONL audit row per gated call into
 *      `~/.cache/prx/github/rate-limit.jsonl` — carrying both the
 *      cost-estimate fields (`remaining_before/after`, `cost_delta`, used by
 *      `estimateSweepCost`) and the GH-1533 attribution fields (`verb`,
 *      `actor`, `api`, `operation`, `cost`, `remaining`, `limit`, `reset_at`,
 *      `duration_ms`) so a budget exhaustion can be traced back to a prx verb
 *      + timestamp. `prx doctor gh-budget` reads this file back.
 *
 * Typed errors propagate to callers; the wrapper never silently retries or
 * downgrades. Fallback policy lives in T2/T3 (issue body).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getAuditRuntimeContext, type GhTruthReason } from "@bounded-systems/audit-context";
import { getEnv } from "@bounded-systems/env";
import { spawnCapture, type CommandResult } from "@bounded-systems/proc";

const GH_TRUTH_REASONS = [
  "forward-orphan-detection",
  "drift-comparator",
  "stale-comparator",
] as const;

export type Bucket = "core" | "graphql" | "search";

const COLD_FALLBACK_AVG = 2;
const ESTIMATE_SAMPLE_SIZE = 50;

export type BudgetSnapshot = {
  bucket: Bucket;
  limit: number;
  remaining: number;
  resetAt: number;
  fetchedAt: number;
};

export type RateLimitDeps = {
  /** Raw runner used to refresh the budget — must NOT be gated. */
  rawRunner?: (cmd: string[]) => CommandResult;
  now?: () => Date;
  homeDir?: () => string;
  ensureDir?: (path: string) => void;
  appendAuditLine?: (path: string, line: string) => void;
  /** Override audit log path. When unset, derives from homeDir. */
  auditPath?: () => string | null;
  /** Override threshold (default 100). */
  threshold?: () => number;
  /** Snapshot TTL in ms (default 30s). */
  snapshotTtlMs?: () => number;
  // GH-1533 — attribution-enrichment seams for the `rate-limit.jsonl` row.
  /** Ambient prx verb/actor for the attribution fields. Defaults to `getAuditRuntimeContext`. */
  runtimeContext?: () => {
    verb: string | null;
    actor: string;
    ghTruthReason: GhTruthReason | null;
  };
  /**
   * Whether to do a free post-call `gh api rate_limit` refresh to derive a
   * measured `cost`. Defaults to `getEnv("PRX_GH_AUDIT_COST") === "1"` —
   * default-off so tests/CI never double a `gh` spawn.
   */
  measureCost?: () => boolean;
};

const DEFAULT_THRESHOLD = 100;
const DEFAULT_SNAPSHOT_TTL_MS = 30_000;

const auditEntrySchema = z.object({
  ts: z.string(),
  argv: z.array(z.string()),
  bucket: z.enum(["core", "graphql", "search"]),
  remaining_before: z.number().nullable(),
  remaining_after: z.number().nullable(),
  exit_code: z.number(),
  threw: z.enum(["BUDGET_EXHAUSTED", "RUNTIME_ERROR"]).nullable(),
  cost_delta: z.number().nullable().default(null),
  // GH-1533 attribution fields. Optional: rows written before GH-1533 (and
  // any row written by a `recordGhResult` call outside `withBucketGate`) lack
  // them, but `auditEntrySchema` must still parse those. Production rows
  // (always via `withBucketGate`) populate all of them.
  //
  //   api        — `graphql` (incl. every `--json` call) or `rest` (the
  //                `core`/`search` pools collapse here); the "was this a
  //                GraphQL call?" filter `prx doctor gh-budget` uses.
  //   verb       — prx verb that issued it (`triage.status`, `intake.search`);
  //                null when the gated runner ran outside `runCli`.
  //   actor      — process identity (`claude-code`, a test harness, …).
  //   operation  — GraphQL query/mutation name, REST path, or `<noun>.<verb>`
  //                for plain `gh` subcommands; null when not derivable.
  //   cost       — exact GraphQL cost when the response carried a `rateLimit`
  //                block, else the measured `remaining_before − remaining_after`
  //                when `PRX_GH_AUDIT_COST=1`, else null. (`cost_delta` above
  //                is the cache-derived estimate kept for `estimateSweepCost`.)
  //   remaining / limit / reset_at — bucket budget after the call (from the
  //                `rateLimit` block, a post-call refresh, or the gate-time
  //                snapshot); reset_at is ISO-8601.
  //   duration_ms — wall time spent in the `gh` spawn (0 for a gated-out call).
  api: z.enum(["graphql", "rest"]).optional(),
  verb: z.string().nullable().optional(),
  actor: z.string().optional(),
  operation: z.string().nullable().optional(),
  cost: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  reset_at: z.string().nullable().optional(),
  duration_ms: z.number().nonnegative().optional(),
  // GH-1602: typed reason a residual gh call survived the triage→bd
  // substitution. `null` (or absent) on every other gh call — that's the
  // signal "this gh call is incidental, not load-bearing." Present values
  // identify the load-bearing comparator: forward-orphan / drift / stale.
  gh_truth_reason: z.enum(GH_TRUTH_REASONS).nullable().optional(),
});
export type RateLimitAuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * The GH-1533 attribution payload `withBucketGate` (and `gateGhArgv` on a
 * pre-spawn block) hands to `writeAudit` to enrich the `rate-limit.jsonl` row.
 */
export type GhCallAttribution = {
  api: "graphql" | "rest";
  verb: string | null;
  actor: string;
  operation: string | null;
  cost: number | null;
  remaining: number | null;
  limit: number | null;
  resetAtMs: number | null;
  durationMs: number;
  ghTruthReason: GhTruthReason | null;
};

export type SweepCounter = {
  scope: string;
  startedAt: number;
  startSnapshots: Partial<Record<Bucket, number>>;
  callsByBucket: Record<Bucket, number>;
  costsByBucket: Record<Bucket, number>;
};

export type SweepCostEstimate = {
  perBucket: Record<Bucket, number>;
  sample: { calls: number; avg: number };
};

const cache = new Map<Bucket, BudgetSnapshot>();
let configuredDeps: RateLimitDeps = {};
let currentSweep: SweepCounter | null = null;

export function configureRateLimit(deps: RateLimitDeps): void {
  configuredDeps = deps;
}

/** Test-only: clear cached budget snapshots. */
export function __resetRateLimitCacheForTesting(): void {
  cache.clear();
  currentSweep = null;
}

export class BucketBudgetExhaustedError extends Error {
  readonly bucket: Bucket;
  readonly remaining: number;
  readonly resetAt: number;
  readonly argv: string[];
  constructor(bucket: Bucket, snapshot: BudgetSnapshot, argv: string[]) {
    super(
      `gh ${bucket} budget exhausted: ${snapshot.remaining} remaining (resets at ${new Date(snapshot.resetAt).toISOString()})`,
    );
    this.name = "BucketBudgetExhaustedError";
    this.bucket = bucket;
    this.remaining = snapshot.remaining;
    this.resetAt = snapshot.resetAt;
    this.argv = argv;
  }
}

export class GraphQLBudgetExhaustedError extends BucketBudgetExhaustedError {
  constructor(snapshot: BudgetSnapshot, argv: string[]) {
    super("graphql", snapshot, argv);
    this.name = "GraphQLBudgetExhaustedError";
  }
}

export class RestBudgetExhaustedError extends BucketBudgetExhaustedError {
  constructor(snapshot: BudgetSnapshot, argv: string[]) {
    super("core", snapshot, argv);
    this.name = "RestBudgetExhaustedError";
  }
}

export class SearchBudgetExhaustedError extends BucketBudgetExhaustedError {
  constructor(snapshot: BudgetSnapshot, argv: string[]) {
    super("search", snapshot, argv);
    this.name = "SearchBudgetExhaustedError";
  }
}

/**
 * Classify a `gh` invocation by argv. Pure; no I/O.
 *
 * Rules (applied in order on argv after stripping leading "gh"):
 *   - `--json` flag anywhere     → graphql
 *   - first two tokens `api graphql` → graphql
 *   - first token `api`           → core   (REST path)
 *   - first token `search`        → search
 *   - else                        → core
 */
export function classifyBucket(argv: readonly string[]): Bucket {
  const args = argv[0] === "gh" ? argv.slice(1) : argv.slice();
  if (args.length === 0) return "core";
  if (args.includes("--json")) return "graphql";
  if (args[0] === "api" && args[1] === "graphql") return "graphql";
  if (args[0] === "api") return "core";
  if (args[0] === "search") return "search";
  return "core";
}

/** True when the argv is a `gh api rate_limit` call (must bypass the gate). */
export function isRateLimitProbe(argv: readonly string[]): boolean {
  const args = argv[0] === "gh" ? argv.slice(1) : argv.slice();
  return args[0] === "api" && args[1] === "rate_limit";
}

function thresholdFor(deps: RateLimitDeps): number {
  if (deps.threshold) return deps.threshold();
  const env = getEnv("PRX_GH_BUDGET_THRESHOLD");
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_THRESHOLD;
}

function snapshotTtlMs(deps: RateLimitDeps): number {
  if (deps.snapshotTtlMs) return deps.snapshotTtlMs();
  return DEFAULT_SNAPSHOT_TTL_MS;
}

function defaultAuditPath(homeDirFn: () => string): string {
  return join(homeDirFn(), ".cache", "prx", "github", "rate-limit.jsonl");
}

function ensureLogDir(path: string, ensureDir?: (p: string) => void): void {
  const dir = dirname(path);
  if (!dir) return;
  if (ensureDir) {
    ensureDir(dir);
    return;
  }
  mkdirSync(dir, { recursive: true });
}

function rawSpawnRunner(cmd: string[]): CommandResult {
  // Routes through @bounded-systems/proc's streaming capture (the sanctioned spawn point).
  // Non-throwing, status-coercing behavior preserved: a spawn error or signal
  // collapses to status 0 with empty output, as the prior direct spawn did.
  const result = spawnCapture(cmd);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 0,
  };
}

function nowDate(deps: RateLimitDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function homeDirOf(deps: RateLimitDeps): string {
  return (deps.homeDir ?? homedir)();
}

function rawRunnerOf(deps: RateLimitDeps): (cmd: string[]) => CommandResult {
  return deps.rawRunner ?? rawSpawnRunner;
}

function appendOf(deps: RateLimitDeps): (path: string, line: string) => void {
  return deps.appendAuditLine ?? ((path, line) => appendFileSync(path, line, "utf8"));
}

const rateLimitResponseSchema = z.object({
  resources: z.object({
    core: z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }),
    graphql: z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }),
    search: z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }),
  }),
});

/**
 * Refresh the snapshot for all three buckets in one `gh api rate_limit`
 * call. Bypasses the gate (would deadlock). On failure, leaves the cache
 * untouched and returns null.
 */
export function refreshBudget(deps: RateLimitDeps = configuredDeps): BudgetSnapshot[] | null {
  const runner = rawRunnerOf(deps);
  const result = runner(["gh", "api", "rate_limit"]);
  if (result.status !== 0 || !result.stdout) return null;
  let parsed: z.infer<typeof rateLimitResponseSchema>;
  try {
    parsed = rateLimitResponseSchema.parse(JSON.parse(result.stdout));
  } catch {
    return null;
  }
  const fetchedAt = nowDate(deps).getTime();
  const snapshots: BudgetSnapshot[] = (["core", "graphql", "search"] as const).map((bucket) => {
    const r = parsed.resources[bucket];
    const snap: BudgetSnapshot = {
      bucket,
      limit: r.limit,
      remaining: r.remaining,
      resetAt: r.reset * 1000,
      fetchedAt,
    };
    cache.set(bucket, snap);
    return snap;
  });
  return snapshots;
}

function getSnapshot(bucket: Bucket, deps: RateLimitDeps): BudgetSnapshot | null {
  const cached = cache.get(bucket);
  const fetchedAt = cached?.fetchedAt ?? 0;
  const ageMs = nowDate(deps).getTime() - fetchedAt;
  if (cached && ageMs < snapshotTtlMs(deps)) {
    return cached;
  }
  refreshBudget(deps);
  return cache.get(bucket) ?? null;
}

function markStale(bucket: Bucket): void {
  cache.delete(bucket);
}

function isRateLimitErrorStderr(stderr: string): boolean {
  return /API rate limit exceeded/i.test(stderr);
}

function writeAudit(
  argv: readonly string[],
  bucket: Bucket,
  remainingBefore: number | null,
  remainingAfter: number | null,
  exitCode: number,
  threw: RateLimitAuditEntry["threw"],
  costDelta: number | null,
  deps: RateLimitDeps,
  attribution?: GhCallAttribution,
): void {
  const overridePath = deps.auditPath?.() ?? null;
  const path = overridePath ?? defaultAuditPath(() => homeDirOf(deps));
  const entry: RateLimitAuditEntry = {
    ts: nowDate(deps).toISOString(),
    argv: [...argv],
    bucket,
    remaining_before: remainingBefore,
    remaining_after: remainingAfter,
    exit_code: exitCode,
    threw,
    cost_delta: costDelta,
    ...(attribution
      ? {
          api: attribution.api,
          verb: attribution.verb,
          actor: attribution.actor,
          operation: attribution.operation,
          cost: attribution.cost,
          remaining: attribution.remaining,
          limit: attribution.limit,
          reset_at:
            attribution.resetAtMs !== null ? new Date(attribution.resetAtMs).toISOString() : null,
          duration_ms: attribution.durationMs,
          gh_truth_reason: attribution.ghTruthReason,
        }
      : {}),
  };
  auditEntrySchema.parse(entry);
  ensureLogDir(path, deps.ensureDir);
  appendOf(deps)(path, `${JSON.stringify(entry)}\n`);
}

function computeCostDelta(
  remainingBefore: number | null,
  remainingAfter: number | null,
): number | null {
  if (remainingBefore === null || remainingAfter === null) return null;
  const delta = remainingBefore - remainingAfter;
  return delta > 0 ? delta : 0;
}

function recordSweepCall(bucket: Bucket, costDelta: number | null): void {
  if (!currentSweep) return;
  currentSweep.callsByBucket[bucket] += 1;
  if (costDelta !== null && costDelta > 0) {
    currentSweep.costsByBucket[bucket] += costDelta;
  }
}

function buildExhaustedError(
  bucket: Bucket,
  snapshot: BudgetSnapshot,
  argv: readonly string[],
): BucketBudgetExhaustedError {
  const argvCopy = [...argv];
  if (bucket === "graphql") return new GraphQLBudgetExhaustedError(snapshot, argvCopy);
  if (bucket === "search") return new SearchBudgetExhaustedError(snapshot, argvCopy);
  return new RestBudgetExhaustedError(snapshot, argvCopy);
}

/**
 * Pre-call gate. Returns null when the call is allowed; otherwise throws a
 * typed budget error. Always emits an audit row for the gated call (the
 * post-call `recordGhResult` should NOT be called when this throws).
 *
 * Skipped (no gate, no audit) for `gh api rate_limit` itself, which is
 * the snapshot probe.
 */
export function gateGhArgv(
  argv: readonly string[],
  deps: RateLimitDeps = configuredDeps,
): { bucket: Bucket; remainingBefore: number | null } | null {
  if (isRateLimitProbe(argv)) return null;
  const bucket = classifyBucket(argv);
  const snapshot = getSnapshot(bucket, deps);
  const remainingBefore = snapshot?.remaining ?? null;
  if (snapshot && snapshot.remaining < thresholdFor(deps)) {
    // GH-1533: the gated-out row still gets full attribution (durationMs 0,
    // cost null, budget from the gating snapshot).
    const rt = runtimeContextOf(deps);
    const attribution: GhCallAttribution = {
      api: bucket === "graphql" ? "graphql" : "rest",
      verb: rt.verb,
      actor: rt.actor,
      operation: ghOperationName(argv),
      cost: null,
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      resetAtMs: snapshot.resetAt,
      durationMs: 0,
      ghTruthReason: rt.ghTruthReason,
    };
    writeAudit(
      argv,
      bucket,
      remainingBefore,
      null,
      -1,
      "BUDGET_EXHAUSTED",
      null,
      deps,
      attribution,
    );
    throw buildExhaustedError(bucket, snapshot, argv);
  }
  return { bucket, remainingBefore };
}

/**
 * Post-call recorder. Inspects stderr for throttling signals; on detected
 * exhaustion, marks the bucket stale, refreshes once, and throws the
 * matching typed error (preserving original exit code on the error). Always
 * emits exactly one audit row.
 *
 * `attribution` (GH-1533) is the verb/operation/cost payload `withBucketGate`
 * pre-computes (it sees the response body + spawn duration); when present it
 * is folded onto the emitted row. Standalone callers (tests) may omit it — the
 * row then carries only the original cost-estimate fields.
 */
export function recordGhResult(
  argv: readonly string[],
  bucket: Bucket,
  remainingBefore: number | null,
  result: CommandResult,
  deps: RateLimitDeps = configuredDeps,
  attribution?: GhCallAttribution,
): void {
  if (isRateLimitProbe(argv)) return;
  if (result.status !== 0 && isRateLimitErrorStderr(result.stderr)) {
    markStale(bucket);
    const fresh = refreshBudget(deps);
    const snapshot = fresh?.find((s) => s.bucket === bucket) ?? cache.get(bucket);
    const remainingAfter = snapshot?.remaining ?? null;
    const costDelta = computeCostDelta(remainingBefore, remainingAfter);
    writeAudit(
      argv,
      bucket,
      remainingBefore,
      remainingAfter,
      result.status,
      "BUDGET_EXHAUSTED",
      costDelta,
      deps,
      attribution,
    );
    recordSweepCall(bucket, costDelta);
    if (snapshot) {
      throw buildExhaustedError(bucket, snapshot, argv);
    }
    // No snapshot available — fall through to plain runtime error.
    writeAudit(
      argv,
      bucket,
      remainingBefore,
      remainingAfter,
      result.status,
      "RUNTIME_ERROR",
      costDelta,
      deps,
      attribution,
    );
    return;
  }
  const cached = cache.get(bucket);
  const remainingAfter = cached?.remaining ?? null;
  const threw = result.status !== 0 ? "RUNTIME_ERROR" : null;
  const costDelta = computeCostDelta(remainingBefore, remainingAfter);
  writeAudit(
    argv,
    bucket,
    remainingBefore,
    remainingAfter,
    result.status,
    threw,
    costDelta,
    deps,
    attribution,
  );
  recordSweepCall(bucket, costDelta);
}

// ─── GH-1533 — per-`gh`-call attribution row helpers ─────────────────────────

/**
 * Best-effort operation name from a `gh` argv. Pure; no I/O (a `-F query=@file`
 * never has its file read). Rules:
 *   - `gh api graphql -f query='query <Name> {…}'` → `<Name>` (null if anonymous)
 *   - `gh api <path> …`                          → `<path>`
 *   - `gh <noun> <verb> …`                       → `<noun>.<verb>`
 *   - else                                       → null
 */
export function ghOperationName(argv: readonly string[]): string | null {
  const args = argv[0] === "gh" ? argv.slice(1) : argv.slice();
  if (args.length === 0) return null;
  if (args[0] === "api") {
    if (args[1] === "graphql") {
      const query = extractGraphqlQueryArg(args.slice(2));
      if (query === undefined) return null; // anonymous-only or @file
      return graphqlOperationNameOf(query);
    }
    for (let i = 1; i < args.length; i++) {
      const token = args[i]!;
      if (!token.startsWith("-")) return token;
    }
    return null;
  }
  const noun = args[0]!;
  if (noun.startsWith("-")) return null;
  const verb = args[1];
  if (!verb || verb.startsWith("-")) return noun;
  return `${noun}.${verb}`;
}

/**
 * Pull the GraphQL query string out of the `-f query=…` / `--field query=…` /
 * `-F query=…` (and joined `-fquery=…`) flags. Returns `undefined` when the
 * query is supplied as `@file` (don't read it) or absent.
 */
function extractGraphqlQueryArg(rest: readonly string[]): string | undefined {
  const fieldFlags = new Set(["-f", "--field", "-F", "--raw-field"]);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    let pair: string | undefined;
    if (fieldFlags.has(token)) {
      pair = rest[i + 1];
    } else if (token.startsWith("-f") && token.length > 2) {
      pair = token.slice(2);
    } else if (token.startsWith("--field=")) {
      pair = token.slice("--field=".length);
    } else if (token.startsWith("--raw-field=")) {
      pair = token.slice("--raw-field=".length);
    }
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) !== "query") continue;
    const value = pair.slice(eq + 1);
    if (value.startsWith("@")) return undefined;
    return value;
  }
  return undefined;
}

function graphqlOperationNameOf(query: string): string | null {
  const m = /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return m ? m[2]! : null;
}

const rateLimitBlockSchema = z.object({
  cost: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  resetAt: z.string().nullable().optional(),
});

type RateLimitBlock = {
  cost: number | null;
  remaining: number | null;
  limit: number | null;
  resetAtMs: number | null;
};

/**
 * Tolerantly parse a GraphQL `rateLimit { cost remaining limit resetAt }` block
 * out of a JSON response body (`.data.rateLimit` or a top-level `rateLimit`).
 * Returns null on parse failure or absent block — never throws.
 */
export function parseRateLimitBlock(stdout: string | undefined): RateLimitBlock | null {
  if (!stdout || stdout.trim().length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  const candidates: unknown[] = [
    typeof data === "object" && data !== null
      ? (data as { rateLimit?: unknown }).rateLimit
      : undefined,
    (body as { rateLimit?: unknown }).rateLimit,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const parsed = rateLimitBlockSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { cost, remaining, limit, resetAt } = parsed.data;
    let resetAtMs: number | null = null;
    if (typeof resetAt === "string") {
      const ms = Date.parse(resetAt);
      resetAtMs = Number.isNaN(ms) ? null : ms;
    }
    return {
      cost: typeof cost === "number" ? cost : null,
      remaining: typeof remaining === "number" ? remaining : null,
      limit: typeof limit === "number" ? limit : null,
      resetAtMs,
    };
  }
  return null;
}

function measureCostOf(deps: RateLimitDeps): boolean {
  if (deps.measureCost) return deps.measureCost();
  return getEnv("PRX_GH_AUDIT_COST") === "1";
}

function runtimeContextOf(deps: RateLimitDeps): {
  verb: string | null;
  actor: string;
  ghTruthReason: GhTruthReason | null;
} {
  return (deps.runtimeContext ?? getAuditRuntimeContext)();
}

/**
 * Build the GH-1533 attribution payload for a completed (success or errored)
 * `gh` spawn. Cost-derivation order:
 *   1. graphql + a `rateLimit { … }` block in the response body → use it
 *      verbatim (and refresh the gate snapshot so `cost_delta` agrees);
 *   2. else `measureCost()` → free post-call `gh api rate_limit` refresh,
 *      `cost = remaining_before − remaining_after`;
 *   3. else → `cost` null; `remaining`/`limit`/`reset_at` from the gate-time
 *      cache snapshot (the cost-estimate path's `cost_delta` already captures
 *      "no observable diff" as 0, so we don't synthesize a cost here).
 *
 * Run *before* `recordGhResult` so the snapshot it reads for `remaining_after`
 * already reflects the block / refresh.
 */
function buildGhCallAttribution(
  argv: readonly string[],
  bucket: Bucket,
  remainingBefore: number | null,
  result: CommandResult,
  durationMs: number,
  deps: RateLimitDeps,
): GhCallAttribution {
  const rt = runtimeContextOf(deps);
  let cost: number | null = null;

  const block = bucket === "graphql" ? parseRateLimitBlock(result.stdout) : null;
  if (block) {
    cost = block.cost;
    if (block.remaining !== null && block.limit !== null && block.resetAtMs !== null) {
      cache.set(bucket, {
        bucket,
        limit: block.limit,
        remaining: block.remaining,
        resetAt: block.resetAtMs,
        fetchedAt: nowDate(deps).getTime(),
      });
    }
  } else if (measureCostOf(deps)) {
    refreshBudget(deps);
  }

  const after = cache.get(bucket) ?? null;
  if (cost === null && (block || measureCostOf(deps)) && remainingBefore !== null && after) {
    cost = Math.max(0, remainingBefore - after.remaining);
  }
  return {
    api: bucket === "graphql" ? "graphql" : "rest",
    verb: rt.verb,
    actor: rt.actor,
    operation: ghOperationName(argv),
    cost,
    remaining: block?.remaining ?? after?.remaining ?? null,
    limit: block?.limit ?? after?.limit ?? null,
    resetAtMs: block?.resetAtMs ?? after?.resetAt ?? null,
    durationMs,
    ghTruthReason: rt.ghTruthReason,
  };
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/**
 * Decorator: wraps a CommandRunner with bucket classification, pre-call
 * gating, and post-call recording. Non-`gh` commands pass through
 * untouched.
 *
 * The inner runner may throw on non-zero exit (the existing `defaultRunner`
 * default is `check: true`); we catch, audit, and re-throw — preserving the
 * `.result` payload the inner runner attaches, but upgrading the error to a
 * typed bucket-exhaustion when stderr matches.
 *
 * GH-1533: the one `rate-limit.jsonl` row already written per gated call is
 * enriched here with attribution fields (verb/operation/cost/…) — see
 * `buildGhCallAttribution`. The pre-spawn gate row is enriched inside
 * `gateGhArgv`. The `gh api rate_limit` probe and non-`gh` commands are
 * excluded (the probe must not self-log).
 */
export function withBucketGate<R extends (cmd: string[], options?: any) => CommandResult>(
  runner: R,
  deps: RateLimitDeps = configuredDeps,
): R {
  const wrapper = (cmd: string[], options?: any): CommandResult => {
    if (cmd[0] !== "gh") {
      return runner(cmd, options);
    }
    // gateGhArgv writes its own (attributed) audit row + throws on exhaustion.
    const gate = gateGhArgv(cmd, deps);
    const start = performance.now();
    let result: CommandResult;
    let threw: unknown;
    try {
      result = runner(cmd, options);
    } catch (err) {
      const attached = (err as { result?: CommandResult } | null)?.result;
      if (!gate || !attached) throw err;
      result = attached;
      threw = err;
    }
    if (gate) {
      const attribution = buildGhCallAttribution(
        cmd,
        gate.bucket,
        gate.remainingBefore,
        result,
        elapsedMs(start),
        deps,
      );
      // recordGhResult writes the (now attributed) row and may itself throw a
      // typed exhaustion on stderr signals — that propagates over `threw`.
      recordGhResult(cmd, gate.bucket, gate.remainingBefore, result, deps, attribution);
    }
    if (threw !== undefined) throw threw;
    return result;
  };
  return wrapper as R;
}

/**
 * Begin a named sweep — captures the starting `BudgetSnapshot.remaining` for
 * each bucket and resets the in-process counter. Subsequent gated calls bump
 * `callsByBucket[bucket]` and accumulate observed `costsByBucket[bucket]`
 * deltas (best-effort from the cached snapshot; see `endSweep` for the
 * authoritative total). Replaces any prior sweep — there's only one in flight
 * per process.
 */
export function beginSweep(scope: string, deps: RateLimitDeps = configuredDeps): SweepCounter {
  const startedAt = nowDate(deps).getTime();
  const snapshots = refreshBudget(deps);
  const startSnapshots: Partial<Record<Bucket, number>> = {};
  if (snapshots) {
    for (const snap of snapshots) startSnapshots[snap.bucket] = snap.remaining;
  }
  currentSweep = {
    scope,
    startedAt,
    startSnapshots,
    callsByBucket: { core: 0, graphql: 0, search: 0 },
    costsByBucket: { core: 0, graphql: 0, search: 0 },
  };
  return currentSweep;
}

/**
 * End the in-flight sweep. Refreshes the snapshot once and reconciles
 * `costsByBucket` against the start-snapshot diff (the authoritative cost of
 * the sweep). Returns the finalised counter and clears the singleton.
 */
export function endSweep(deps: RateLimitDeps = configuredDeps): SweepCounter | null {
  const sweep = currentSweep;
  if (!sweep) return null;
  const snapshots = refreshBudget(deps);
  if (snapshots) {
    for (const snap of snapshots) {
      const start = sweep.startSnapshots[snap.bucket];
      if (typeof start === "number") {
        const delta = start - snap.remaining;
        sweep.costsByBucket[snap.bucket] = delta > 0 ? delta : 0;
      }
    }
  }
  currentSweep = null;
  return sweep;
}

/** Snapshot of the in-flight sweep counter (no I/O). */
export function getSweepCost(): SweepCounter | null {
  if (!currentSweep) return null;
  return {
    scope: currentSweep.scope,
    startedAt: currentSweep.startedAt,
    startSnapshots: { ...currentSweep.startSnapshots },
    callsByBucket: { ...currentSweep.callsByBucket },
    costsByBucket: { ...currentSweep.costsByBucket },
  };
}

/**
 * Estimate the GraphQL cost of a sweep over `queueSize` issues by averaging
 * recent per-call `cost_delta` values from the audit log.
 *
 * Reads the tail of the audit log (default 50 rows), filters to GraphQL rows
 * with a non-null positive `cost_delta`, and computes a rolling average. When
 * no usable sample exists (cold log, or every recent delta was 0 because the
 * cache never refreshed mid-sweep), falls back to `COLD_FALLBACK_AVG` (2 — a
 * "list + view per issue" baseline) and reports `sample.calls = 0`.
 */
export function estimateSweepCost(
  queueSize: number,
  deps: RateLimitDeps = configuredDeps,
): SweepCostEstimate {
  const path = deps.auditPath?.() ?? defaultAuditPath(() => homeDirOf(deps));
  let avg = COLD_FALLBACK_AVG;
  let sampleCalls = 0;
  if (path) {
    const rows = readAuditTail(path, ESTIMATE_SAMPLE_SIZE * 4);
    const graphqlRows = rows.filter(
      (row) => row.bucket === "graphql" && typeof row.cost_delta === "number" && row.cost_delta > 0,
    );
    const sample = graphqlRows.slice(-ESTIMATE_SAMPLE_SIZE);
    if (sample.length > 0) {
      const total = sample.reduce((acc, row) => acc + (row.cost_delta ?? 0), 0);
      avg = total / sample.length;
      sampleCalls = sample.length;
    }
  }
  const safeQueue = Math.max(0, Math.floor(queueSize));
  const perBucket: Record<Bucket, number> = {
    core: 0,
    graphql: avg * safeQueue,
    search: 0,
  };
  return { perBucket, sample: { calls: sampleCalls, avg } };
}

function readAuditTail(path: string, maxRows: number): RateLimitAuditEntry[] {
  // GH-1218 follow-up: this currently slurps the full audit log, then keeps
  // only the last `maxRows` parsed entries. Adequate while operators rotate
  // ~/.cache/prx/github/rate-limit.jsonl manually, but a true byte-bounded
  // tail read is the right next step if the log grows unbounded.
  let raw: string;
  try {
    // No statSync pre-check: readFileSync throws ENOENT into the same catch,
    // so the check only added a TOCTOU window (CodeQL js/file-system-race).
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-maxRows);
  const out: RateLimitAuditEntry[] = [];
  for (const line of tail) {
    try {
      const parsed = auditEntrySchema.parse(JSON.parse(line));
      out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Read every parseable row from `~/.cache/prx/github/rate-limit.jsonl` (or the
 * `auditPath` override). Used by `prx doctor gh-budget` for its time-windowed
 * read-back (GH-1533); malformed lines are skipped, not thrown.
 */
export function readRateLimitAuditRows(
  deps: RateLimitDeps = configuredDeps,
): RateLimitAuditEntry[] {
  const path = deps.auditPath?.() ?? defaultAuditPath(() => homeDirOf(deps));
  if (!path) return [];
  return readAuditTail(path, Number.MAX_SAFE_INTEGER);
}

/**
 * Render a `BudgetSnapshot.resetAt` (epoch ms) as `HH:MM:SS UTC`. UTC over
 * local time so audit logs and operator sessions across machines compare
 * apples to apples (Copilot review on PR #1278).
 */
export function formatBudgetResetTime(resetAt: number): string {
  const date = new Date(resetAt);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

/**
 * Render the operator-facing "GitHub budget:" block shared by `prx triage
 * status --rate-limit` and `prx intake status --rate-limit`. Extracted to
 * keep the two callers from drifting (Copilot review on PR #1278).
 */
export function formatBudgetBlock(
  snapshots: BudgetSnapshot[],
  estimate: SweepCostEstimate,
): string {
  const lines: string[] = [];
  lines.push("GitHub budget:");
  for (const snap of snapshots) {
    const reset = formatBudgetResetTime(snap.resetAt);
    const label = `${snap.bucket}:`.padEnd(9, " ");
    lines.push(`  ${label} ${snap.remaining}/${snap.limit} (resets ${reset})`);
  }
  const graphqlCost = Math.ceil(estimate.perBucket.graphql);
  const queue = estimate.sample.avg > 0 ? Math.round(graphqlCost / estimate.sample.avg) : 0;
  const sampleNote =
    estimate.sample.calls > 0
      ? `${queue} issues × avg ${estimate.sample.avg.toFixed(1)} pts, n=${estimate.sample.calls}`
      : `cold sample, fallback avg ${estimate.sample.avg.toFixed(1)} pts/issue`;
  lines.push(`Estimated sweep cost: ~${graphqlCost} GraphQL points (${sampleNote})`);
  return lines.join("\n");
}
