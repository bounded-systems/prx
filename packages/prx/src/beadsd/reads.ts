/**
 * Daemon-routed beads reads (GH-296 migration).
 *
 * The single-source replacements for local `execBd` read primitives: these go
 * through {@link withBeadsClient} (local socket or the VM), so host code reads
 * the one beads the daemon owns — no per-clone bd.
 *
 * The daemon returns RAW `bd --json` (snake_case `external_ref`, `issue_type`,
 * …), so these readers run the same {@link parseBeadsRecords} transform the
 * local `bd list` path uses — otherwise callers see snake_case fields cast
 * blindly to {@link BeadsRecord}.
 *
 * Prefer the TARGETED readers ({@link showBeadViaDaemon}) over
 * {@link loadAllBeadsViaDaemon}: a single-id lookup should ask the daemon for
 * that one record, not pull the whole set and `.find()` in JS. Loading `--all`
 * to pick one record is wasteful and poisons provenance with the entire DB —
 * `--all` is for genuine aggregate (scout-shaped) reads only.
 */

import { withBeadsClient, type WithBeadsClientDeps } from "./client-factory.ts";
import { parseBeadsRecord, parseBeadsRecords, type BeadsRecord } from "../triage/triage.ts";

/**
 * Daemon-routed `bd show <id> --json` → one parsed record, or null if no such
 * id. The targeted read: provenance is `(show <id> → record)`, not the whole DB.
 */
export async function showBeadViaDaemon(
  id: string,
  deps: WithBeadsClientDeps = {},
): Promise<BeadsRecord | null> {
  return withBeadsClient(async (client) => {
    const reply = await client.query({ kind: "show", id });
    if (reply.status === "error") {
      // not-found is data, not an exception, to mirror `bd show` callers.
      if (/not.?found|no (issue|record)/i.test(reply.message)) return null;
      throw new Error(`beadsd show ${id}: ${reply.code}: ${reply.message}`);
    }
    const raw = Array.isArray(reply.result) ? reply.result[0] : reply.result;
    return parseBeadsRecord(raw);
  }, deps);
}

/**
 * Daemon-routed `bd list --all --json --limit 0` → all parsed records.
 *
 * Aggregate read — use only when an operation genuinely needs the whole set
 * (sync/backfill reconcile, dedupe, drift, scout dep-graph). For a single-id
 * lookup use {@link showBeadViaDaemon} instead.
 */
export async function loadAllBeadsViaDaemon(deps: WithBeadsClientDeps = {}): Promise<BeadsRecord[]> {
  return withBeadsClient(async (client) => {
    const reply = await client.query({ kind: "list", all: true, limit: 0 });
    if (reply.status === "error") {
      throw new Error(`beadsd list --all: ${reply.code}: ${reply.message}`);
    }
    return Array.isArray(reply.result) ? parseBeadsRecords(reply.result) : [];
  }, deps);
}
