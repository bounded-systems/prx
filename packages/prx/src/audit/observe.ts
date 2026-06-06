// Read side of the audit NDJSON sink: surface a work unit's pilot telemetry
// (the `TELEMETRY_*` catalog-event rows the seams + legs emit) as a timeline.
// Pairs with `appendAuditRow` in sink.ts; backs the `prx observe` verb.

import { readFileSync } from "node:fs";

import { auditSinkPath, type AuditSinkPathOptions } from "./sink.ts";

export type TelemetryEvent = {
  ts: string;
  event: string;
  details?: Record<string, unknown>;
};

/** Read raw file text; a missing file (no audit yet) reads as empty, not an error. */
export type AuditReadFn = (path: string) => string;

const defaultReadFn: AuditReadFn = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export type ReadUnitTelemetryOptions = {
  workUnitId: string;
  /** Day bucket to read (the sink is one NDJSON file per `YYYY-MM-DD`). */
  date: Date;
  /** Keep only the most recent `limit` events. */
  limit?: number | undefined;
  /** Filesystem seam — tests inject crafted NDJSON. */
  readFn?: AuditReadFn | undefined;
} & AuditSinkPathOptions;

/**
 * Read one work unit's telemetry timeline from the daily audit NDJSON: every
 * `catalog-event` row whose `event` starts with `TELEMETRY_` for that unit, in
 * file order (chronological). Malformed lines are skipped, not fatal. This is a
 * pure projection of the operator-visible log — it never gates anything.
 */
export function readUnitTelemetry(opts: ReadUnitTelemetryOptions): TelemetryEvent[] {
  const path = auditSinkPath(opts.date, {
    ...(opts.stateDirOverride !== undefined ? { stateDirOverride: opts.stateDirOverride } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  const text = (opts.readFn ?? defaultReadFn)(path);
  if (!text) return [];

  const events: TelemetryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated/partial trailing line is not fatal
    }
    const event = row["event"];
    if (
      row["workUnitId"] !== opts.workUnitId ||
      typeof event !== "string" ||
      !event.startsWith("TELEMETRY_")
    ) {
      continue;
    }
    events.push({
      ts: String(row["ts"] ?? ""),
      event,
      ...(row["details"] && typeof row["details"] === "object"
        ? { details: row["details"] as Record<string, unknown> }
        : {}),
    });
  }

  return opts.limit && opts.limit > 0 ? events.slice(-opts.limit) : events;
}
