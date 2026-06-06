/**
 * Daemon-routed beads reads (GH-296 migration).
 *
 * The single-source replacements for local `execBd` read primitives: these go
 * through {@link withBeadsClient} (local socket or the VM), so host code reads
 * the one beads the daemon owns — no per-clone bd. As call sites migrate off the
 * sync `execBd` readers (e.g. triage's `loadAllBeads`) onto these, the local bd
 * read path is retired.
 */

import { withBeadsClient, type WithBeadsClientDeps } from "./client-factory.ts";
import type { BeadsRecord } from "../triage/triage.ts";

/** Daemon-routed `bd list --all --json --limit 0` → all beads records. */
export async function loadAllBeadsViaDaemon(deps: WithBeadsClientDeps = {}): Promise<BeadsRecord[]> {
  return withBeadsClient(async (client) => {
    const reply = await client.query({ kind: "list", all: true, limit: 0 });
    if (reply.status === "error") {
      throw new Error(`beadsd list --all: ${reply.code}: ${reply.message}`);
    }
    return Array.isArray(reply.result) ? (reply.result as BeadsRecord[]) : [];
  }, deps);
}

/** Daemon-routed `bd show <id> --json` → one record, or null if not found. */
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
    const rec = Array.isArray(reply.result) ? reply.result[0] : reply.result;
    return (rec as BeadsRecord) ?? null;
  }, deps);
}
