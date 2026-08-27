// GH-1407 — Anthropic services projector.
//
// Reads `non-interactive-agent/usage` audit rows out of the audit metrics
// store (the generic `events` table — the rows already land there per
// GH-1823's uniform ingester) and rolls them up into per-bucket cache hit
// rates so `prx services status --anthropic` can answer "is the cache split
// shipped in GH-1407 actually buying anything?".
//
// Pure projector: no I/O beyond the supplied `Database` handle. CLI shape
// lives in `src/services/cli.ts`.

import type { Database } from "bun:sqlite";

export type AnthropicProjectorBy = "profile" | "actor" | "workUnitId" | "model";

export type AnthropicProjectorOptions = {
  /**
   * ISO timestamp floor — rows older than this are excluded. Pass the
   * caller-resolved `--window=Nd` cutoff or `undefined` for "all time".
   */
  since?: string;
  /** Grouping dimension. Defaults to `profile`. */
  by?: AnthropicProjectorBy;
};

export type AnthropicUsageBucket = {
  bucket: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  /**
   * cache_read / (input + cache_read). `cache_creation_input_tokens` is a
   * sunk cost the first time a stable prefix is observed, not a hit signal —
   * a high creation count with a low read count means the prefix is not
   * being reused, which is the bug we're measuring. Returns 0 when both
   * sides are zero.
   */
  hit_rate: number;
};

type EventRow = { raw_json: string };

type UsagePayload = {
  subkind?: string;
  profile?: string;
  actor?: string;
  workUnitId?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
};

function bucketKey(row: UsagePayload, by: AnthropicProjectorBy): string {
  if (by === "actor") return row.actor ?? "(unknown actor)";
  if (by === "workUnitId") return row.workUnitId ?? "(unattached)";
  if (by === "model") return row.model ?? "(unknown model)";
  return row.profile ?? "(unknown profile)";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * One point on the cost-vs-outcome diamond for a single model.
 *
 * Cost axis  — `avg_cost_usd`: average spend per work unit attributed to this
 *              model (the work unit is assigned to its dominant model by cost).
 * Outcome axis — `completion_rate`: fraction of work units that reached a
 *              terminal "merged" or "cleaned" state in the transitions log.
 */
export type DiamondPoint = {
  model: string;
  work_units: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  completed: number;
  closed: number;
  in_progress: number;
  completion_rate: number;
  hit_rate: number;
};

const COMPLETED_STATES = new Set(["merged", "cleaned"]);
const CLOSED_STATES = new Set(["closed"]);

type TransitionRow = { issue: string; state_to: string; ts: string };

type WuidOutcome = {
  dominantModel: string;
  totalCost: number;
  totalCacheRead: number;
  totalInput: number;
  outcome: "completed" | "closed" | "in_progress";
};

/**
 * Shared loader used by both the diamond and series projectors.
 *
 * For each work unit that has at least one attributed usage event, resolves
 * the dominant model (highest cost share) and the outcome from the latest
 * transition. Work units with no `workUnitId` are skipped — there is no
 * outcome to measure for unattached sessions.
 */
function buildWuidOutcomes(db: Database, since?: string): WuidOutcome[] {
  const rows = since
    ? db
        .query<EventRow, [string]>(
          `SELECT raw_json FROM events WHERE action = 'non-interactive-agent' AND ts >= ?`,
        )
        .all(since)
    : db
        .query<EventRow, []>(`SELECT raw_json FROM events WHERE action = 'non-interactive-agent'`)
        .all();

  type ModelAccum = { cost: number; cache_read: number; input: number };
  const byWuid = new Map<string, Map<string, ModelAccum>>();

  for (const row of rows) {
    let payload: UsagePayload;
    try {
      payload = JSON.parse(row.raw_json) as UsagePayload;
    } catch {
      continue;
    }
    if (payload.subkind !== "usage") continue;
    const wuid = payload.workUnitId;
    if (!wuid) continue;
    const model = payload.model ?? "(unknown model)";
    const inner = byWuid.get(wuid) ?? new Map<string, ModelAccum>();
    const entry = inner.get(model) ?? { cost: 0, cache_read: 0, input: 0 };
    entry.cost += num(payload.total_cost_usd);
    entry.cache_read += num(payload.cache_read_input_tokens);
    entry.input += num(payload.input_tokens);
    inner.set(model, entry);
    byWuid.set(wuid, inner);
  }

  if (byWuid.size === 0) return [];

  const allTransitions = db
    .query<TransitionRow, []>(`SELECT issue, state_to, ts FROM transitions ORDER BY ts ASC`)
    .all();
  const latestState = new Map<string, string>();
  for (const t of allTransitions) {
    if (t.issue) latestState.set(t.issue, t.state_to);
  }

  const outcomes: WuidOutcome[] = [];
  for (const [wuid, modelMap] of byWuid) {
    let dominantModel = "(unknown model)";
    let maxCost = -1;
    let totalCost = 0;
    let totalCacheRead = 0;
    let totalInput = 0;
    for (const [model, accum] of modelMap) {
      totalCost += accum.cost;
      totalCacheRead += accum.cache_read;
      totalInput += accum.input;
      if (accum.cost > maxCost) {
        maxCost = accum.cost;
        dominantModel = model;
      }
    }
    const state = latestState.get(wuid);
    const outcome = state
      ? COMPLETED_STATES.has(state)
        ? "completed"
        : CLOSED_STATES.has(state)
          ? "closed"
          : "in_progress"
      : "in_progress";
    outcomes.push({ dominantModel, totalCost, totalCacheRead, totalInput, outcome });
  }
  return outcomes;
}

export function projectAnthropicDiamond(
  db: Database,
  opts: AnthropicProjectorOptions = {},
): DiamondPoint[] {
  const outcomes = buildWuidOutcomes(db, opts.since);
  if (outcomes.length === 0) return [];

  type ModelAgg = {
    work_units: number;
    total_cost: number;
    completed: number;
    closed: number;
    in_progress: number;
    total_cache_read: number;
    total_input: number;
  };
  const modelAgg = new Map<string, ModelAgg>();

  for (const { dominantModel, totalCost, totalCacheRead, totalInput, outcome } of outcomes) {
    const agg = modelAgg.get(dominantModel) ?? {
      work_units: 0,
      total_cost: 0,
      completed: 0,
      closed: 0,
      in_progress: 0,
      total_cache_read: 0,
      total_input: 0,
    };
    agg.work_units += 1;
    agg.total_cost += totalCost;
    agg.total_cache_read += totalCacheRead;
    agg.total_input += totalInput;
    if (outcome === "completed") agg.completed += 1;
    else if (outcome === "closed") agg.closed += 1;
    else agg.in_progress += 1;
    modelAgg.set(dominantModel, agg);
  }

  return [...modelAgg.entries()]
    .map(([model, agg]) => {
      const denom = agg.total_input + agg.total_cache_read;
      return {
        model,
        work_units: agg.work_units,
        total_cost_usd: agg.total_cost,
        avg_cost_usd: agg.work_units > 0 ? agg.total_cost / agg.work_units : 0,
        completed: agg.completed,
        closed: agg.closed,
        in_progress: agg.in_progress,
        completion_rate: agg.work_units > 0 ? agg.completed / agg.work_units : 0,
        hit_rate: denom === 0 ? 0 : agg.total_cache_read / denom,
      };
    })
    .sort((a, b) => b.completion_rate - a.completion_rate || b.total_cost_usd - a.total_cost_usd);
}

/**
 * One point on the effort/token series — a (model, cost_tier) pair showing
 * completion rate within a specific spend band.
 *
 * The series exposes the non-monotonic relationship between spend and outcome:
 * more tokens ≠ better results past a model-specific peak. Use it to pick the
 * cost-efficient tier for each task rather than defaulting to max effort.
 */
export type SeriesPoint = {
  model: string;
  tier: string;
  tier_min: number;
  tier_max: number;
  work_units: number;
  avg_cost_usd: number;
  completion_rate: number;
  hit_rate: number;
};

// Cost bands chosen to capture the ~$8 non-monotonic peak observed in
// Opus 4.8 (peaks around $8, dips past $10.5 — higher spend ≠ better outcome).
const COST_TIERS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "<$2", min: 0, max: 2 },
  { label: "$2–$5", min: 2, max: 5 },
  { label: "$5–$10", min: 5, max: 10 },
  { label: "$10–$20", min: 10, max: 20 },
  { label: "$20–$40", min: 20, max: 40 },
  { label: "$40+", min: 40, max: Infinity },
];

function costTier(cost: number): (typeof COST_TIERS)[number] {
  for (const tier of COST_TIERS) {
    if (cost < tier.max) return tier;
  }
  return COST_TIERS[COST_TIERS.length - 1]!;
}

export function projectAnthropicSeries(
  db: Database,
  opts: AnthropicProjectorOptions = {},
): SeriesPoint[] {
  const outcomes = buildWuidOutcomes(db, opts.since);
  if (outcomes.length === 0) return [];

  type TierAgg = {
    work_units: number;
    total_cost: number;
    completed: number;
    total_cache_read: number;
    total_input: number;
  };
  // key = `${model}\x00${tierLabel}`
  const tierAgg = new Map<string, TierAgg & { tier: (typeof COST_TIERS)[number] }>();

  for (const { dominantModel, totalCost, totalCacheRead, totalInput, outcome } of outcomes) {
    const tier = costTier(totalCost);
    const key = `${dominantModel}\x00${tier.label}`;
    const agg = tierAgg.get(key) ?? {
      work_units: 0,
      total_cost: 0,
      completed: 0,
      total_cache_read: 0,
      total_input: 0,
      tier,
    };
    agg.work_units += 1;
    agg.total_cost += totalCost;
    agg.total_cache_read += totalCacheRead;
    agg.total_input += totalInput;
    if (outcome === "completed") agg.completed += 1;
    tierAgg.set(key, agg);
  }

  return [...tierAgg.entries()]
    .map(([key, agg]) => {
      const model = key.split("\x00")[0]!;
      const denom = agg.total_input + agg.total_cache_read;
      return {
        model,
        tier: agg.tier.label,
        tier_min: agg.tier.min,
        tier_max: agg.tier.max === Infinity ? -1 : agg.tier.max,
        work_units: agg.work_units,
        avg_cost_usd: agg.work_units > 0 ? agg.total_cost / agg.work_units : 0,
        completion_rate: agg.work_units > 0 ? agg.completed / agg.work_units : 0,
        hit_rate: denom === 0 ? 0 : agg.total_cache_read / denom,
      };
    })
    .sort((a, b) => {
      const modelCmp = a.model.localeCompare(b.model);
      return modelCmp !== 0 ? modelCmp : a.tier_min - b.tier_min;
    });
}

export function projectAnthropicUsage(
  db: Database,
  opts: AnthropicProjectorOptions = {},
): AnthropicUsageBucket[] {
  const by: AnthropicProjectorBy = opts.by ?? "profile";
  const since = opts.since;

  // Filter by action='non-interactive-agent' (the unified `action` column
  // already reflects `kind` for sink rows per the ingester's row mapper at
  // src/audit/store/ingest.ts:83). Subkind narrowing happens in code so we
  // do not have to teach SQLite about every audit-row variant.
  const rows = since
    ? db
        .query<EventRow, [string]>(
          `SELECT raw_json FROM events WHERE action = 'non-interactive-agent' AND ts >= ?`,
        )
        .all(since)
    : db
        .query<EventRow, []>(`SELECT raw_json FROM events WHERE action = 'non-interactive-agent'`)
        .all();

  const groups = new Map<string, AnthropicUsageBucket>();
  for (const row of rows) {
    let payload: UsagePayload;
    try {
      payload = JSON.parse(row.raw_json) as UsagePayload;
    } catch {
      continue;
    }
    if (payload.subkind !== "usage") continue;

    const key = bucketKey(payload, by);
    const bucket = groups.get(key) ?? {
      bucket: key,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0,
      hit_rate: 0,
    };
    bucket.calls += 1;
    bucket.input_tokens += num(payload.input_tokens);
    bucket.output_tokens += num(payload.output_tokens);
    bucket.cache_read_input_tokens += num(payload.cache_read_input_tokens);
    bucket.cache_creation_input_tokens += num(payload.cache_creation_input_tokens);
    bucket.total_cost_usd += num(payload.total_cost_usd);
    groups.set(key, bucket);
  }

  const buckets = [...groups.values()];
  for (const b of buckets) {
    const denom = b.input_tokens + b.cache_read_input_tokens;
    b.hit_rate = denom === 0 ? 0 : b.cache_read_input_tokens / denom;
  }
  buckets.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return buckets;
}

/**
 * Resolve a window flag (`7d`, `24h`, `30m`, or an ISO timestamp) into an
 * ISO floor relative to `now`. Returns `undefined` when no window is
 * specified, so callers project across the full audit store.
 */
export function resolveWindowFloor(
  window: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!window) return undefined;
  const trimmed = window.trim();
  if (trimmed.length === 0) return undefined;
  // ISO passthrough — anything with a `T` or `:` is treated as an absolute
  // floor. Lets operators paste `--window=2026-05-10T00:00:00Z` directly.
  if (trimmed.includes("T") || trimmed.includes(":")) return trimmed;

  const match = trimmed.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(
      `anthropic: invalid --window value '${window}' (expected Nd / Nh / Nm or ISO timestamp)`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "d"
      ? amount * 86_400_000
      : unit === "h"
        ? amount * 3_600_000
        : /* m */ amount * 60_000;
  return new Date(now.getTime() - ms).toISOString();
}
