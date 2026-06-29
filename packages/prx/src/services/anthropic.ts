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
