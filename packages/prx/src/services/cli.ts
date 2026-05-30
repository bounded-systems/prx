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
  projectAnthropicUsage,
  resolveWindowFloor,
  type AnthropicProjectorBy,
  type AnthropicUsageBucket,
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

  const db = deps.db ?? (deps.openDb ?? openAuditDb)({
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
    output.log(JSON.stringify({
      plane: "anthropic",
      window: opts.window ?? null,
      since: since ?? null,
      by: opts.by ?? "profile",
      buckets,
    }));
  } else {
    renderText(buckets, opts, output);
  }

  if (!deps.db) db.close();
  return 0;
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
