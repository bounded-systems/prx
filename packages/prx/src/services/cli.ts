// GH-1407 — `prx services status` CLI handler.
//
// `--anthropic` is the only plane this verb ships today; per-actor budgets
// are GH-1826's surface. The handler opens the audit metrics DB, runs
// `projectAnthropicUsage`, and renders either a tabular line per bucket
// (plain) or a single JSON object (machine consumers).

import type { Database } from "bun:sqlite";

import { openAuditDb } from "../audit/store/db.ts";
import { ingestAuditSources } from "../audit/store/ingest.ts";
import {
  projectAnthropicDiamond,
  projectAnthropicUsage,
  resolveWindowFloor,
  type AnthropicProjectorBy,
  type AnthropicUsageBucket,
  type DiamondPoint,
} from "./anthropic.ts";

export type ServicesOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type ServicesCliDeps = {
  openDb?: typeof openAuditDb;
  /** Pre-opened DB handle. Tests use `:memory:` after seeding fixture rows. */
  db?: Database;
  /** Override XDG_STATE_HOME / homedir lookup. */
  stateDirOverride?: string;
  /** Audit NDJSON dir to (re-)ingest before projecting. Skips ingest when absent. */
  auditDir?: string;
  /** Transition log dir to (re-)ingest before projecting. */
  transitionDir?: string;
  now?: () => Date;
};

export type RunServicesStatusOptions = {
  anthropic: boolean;
  window?: string;
  by?: AnthropicProjectorBy;
  format?: "plain" | "json";
};

export function runServicesStatus(
  opts: RunServicesStatusOptions,
  output: ServicesOutput,
  deps: ServicesCliDeps = {},
): number {
  if (!opts.anthropic) {
    output.error(
      "prx services status: --anthropic is required (per-actor planes ship with GH-1826)",
    );
    return 2;
  }

  const db =
    deps.db ??
    (deps.openDb ?? openAuditDb)({
      stateDirOverride: deps.stateDirOverride,
    });

  // When the caller pointed us at NDJSON sources, refresh the store before
  // projecting so the verb is single-shot (no separate `audit ingest`).
  if (deps.auditDir || deps.transitionDir) {
    ingestAuditSources(db, {
      ...(deps.auditDir ? { auditDir: deps.auditDir } : {}),
      ...(deps.transitionDir ? { transitionDir: deps.transitionDir } : {}),
    });
  }

  const since = resolveWindowFloor(opts.window, deps.now?.() ?? new Date());
  const buckets = projectAnthropicUsage(db, {
    ...(since ? { since } : {}),
    by: opts.by ?? "profile",
  });

  if (opts.format === "json") {
    output.log(
      JSON.stringify({
        plane: "anthropic",
        window: opts.window ?? null,
        since: since ?? null,
        by: opts.by ?? "profile",
        buckets,
      }),
    );
  } else {
    renderText(buckets, opts, output);
  }

  if (!deps.db) db.close();
  return 0;
}

export type RunServicesDiamondOptions = {
  window?: string;
  format?: "plain" | "json";
};

export function runServicesDiamond(
  opts: RunServicesDiamondOptions,
  output: ServicesOutput,
  deps: ServicesCliDeps = {},
): number {
  const db =
    deps.db ??
    (deps.openDb ?? openAuditDb)({
      stateDirOverride: deps.stateDirOverride,
    });

  if (deps.auditDir || deps.transitionDir) {
    ingestAuditSources(db, {
      ...(deps.auditDir ? { auditDir: deps.auditDir } : {}),
      ...(deps.transitionDir ? { transitionDir: deps.transitionDir } : {}),
    });
  }

  const since = resolveWindowFloor(opts.window, deps.now?.() ?? new Date());
  const points = projectAnthropicDiamond(db, { ...(since ? { since } : {}) });

  if (opts.format === "json") {
    output.log(
      JSON.stringify({
        plane: "anthropic",
        window: opts.window ?? null,
        since: since ?? null,
        points,
      }),
    );
  } else {
    renderDiamond(points, opts, output);
  }

  if (!deps.db) db.close();
  return 0;
}

function renderDiamond(
  points: DiamondPoint[],
  opts: RunServicesDiamondOptions,
  output: ServicesOutput,
): void {
  const windowLabel = opts.window ? ` (window=${opts.window})` : "";
  output.log(`anthropic services diamond — cost vs outcome by model${windowLabel}`);
  if (points.length === 0) {
    output.log(
      "  (no work-unit cost data found — try `prx audit ingest` with --audit-dir and --transition-dir)",
    );
    return;
  }
  output.log(
    `  ${"model".padEnd(28)} ${"wus".padStart(5)} ${"avg_cost".padStart(10)} ${"completion".padStart(11)} ${"hit_rate".padStart(9)}`,
  );
  for (const p of points) {
    const completionPct = (p.completion_rate * 100).toFixed(1) + "%";
    const hitPct = (p.hit_rate * 100).toFixed(1) + "%";
    output.log(
      `  ${p.model.padEnd(28)} ${String(p.work_units).padStart(5)} ${("$" + p.avg_cost_usd.toFixed(2)).padStart(10)} ${completionPct.padStart(11)} ${hitPct.padStart(9)}`,
    );
  }
}

function renderText(
  buckets: AnthropicUsageBucket[],
  opts: RunServicesStatusOptions,
  output: ServicesOutput,
): void {
  const windowLabel = opts.window ? ` (window=${opts.window})` : "";
  output.log(`anthropic services status — by=${opts.by ?? "profile"}${windowLabel}`);
  if (buckets.length === 0) {
    output.log("  (no non-interactive-agent/usage rows found — try `prx audit ingest` first)");
    return;
  }
  for (const b of buckets) {
    const ratePct = (b.hit_rate * 100).toFixed(1);
    output.log(
      `  ${b.bucket}: calls=${b.calls} input=${b.input_tokens} cache_read=${b.cache_read_input_tokens} cache_create=${b.cache_creation_input_tokens} cost_usd=${b.total_cost_usd.toFixed(4)} hit_rate=${ratePct}%`,
    );
  }
}
