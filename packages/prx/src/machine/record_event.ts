// GH-1616 — `recordEvent()` thin helper for catalog-event audit rows.
//
// Single chokepoint between catalog-event emitters (`nextWork()` and
// future siblings) and the daily audit NDJSON sink. Looks the event's
// owning actor up in `eventOwnerMap` so the row's `actor` field is
// derived from the catalog, not the call-site. Unknown event names throw
// — the trust boundary here is the actor catalog, and a typo'd name
// silently writing to the sink is exactly the regression class I-BD3 is
// meant to prevent (operator observability of cache lifecycle).

import { appendAuditRow, type AuditSinkDeps } from "../audit/sink.ts";
import { eventOwnerMap } from "./actors.ts";

export type RecordEventOptions = {
  workUnitId?: string | undefined;
  repo?: string | undefined;
  details?: Record<string, unknown> | undefined;
  /** Sink DI seam — forwarded to `appendAuditRow`. */
  deps?: AuditSinkDeps | undefined;
  /** Clock override (tests inject a fixed `now`). */
  now?: (() => Date) | undefined;
};

/**
 * Record one catalog event as a `catalog-event` audit row. The owning
 * actor is looked up in `eventOwnerMap`; an unknown event name throws.
 */
export function recordEvent(event: string, opts: RecordEventOptions = {}): void {
  const actor = eventOwnerMap[event];
  if (!actor) {
    throw new Error(
      `recordEvent: unknown catalog event \`${event}\` — declare it in eventOwnerMap`,
    );
  }
  const ts = (opts.now ?? (() => new Date()))().toISOString();
  appendAuditRow(
    {
      ts,
      kind: "catalog-event" as const,
      event,
      actor,
      ...(opts.workUnitId ? { workUnitId: opts.workUnitId } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
    opts.deps,
  );
}
