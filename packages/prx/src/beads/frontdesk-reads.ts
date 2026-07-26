/**
 * Aggregate + targeted work-item reads, from Front Desk (GH-1012).
 *
 * Historically these went through the beadsd daemon ({@link withBeadsClient}).
 * Since GH-1017 the daemon's list/show case already served Front Desk, so these
 * now read Front Desk DIRECTLY via `frontDeskBeadsRaw`/`frontDeskBeadRaw` —
 * dropping the daemon hop (a step toward deleting beadsd + bd). Records are
 * GH-canonical (`id = GH-<n>`); the `parseBeadsRecords` transform is unchanged.
 * The `deps` arg is retained for call-site/signature compatibility.
 */

import { parseBeadsRecord, parseBeadsRecords, type BeadsRecord } from "../triage/triage.ts";
import { frontDeskBeadRaw, frontDeskBeadsRaw, type FrontDeskListDeps } from "./frontdesk-list.ts";

/** Injectable Front Desk read deps: the runner + the repo-resolving cwd. */
export type FrontDeskReadDeps = FrontDeskListDeps & { cwd?: string | undefined };

/**
 * Daemon-routed `bd show <id> --json` → one parsed record, or null if no such
 * id. The targeted read: provenance is `(show <id> → record)`, not the whole DB.
 */
export async function showBeadViaDaemon(
  id: string,
  deps: FrontDeskReadDeps = {},
): Promise<BeadsRecord | null> {
  const { cwd, ...listDeps } = deps;
  const raw = frontDeskBeadRaw(cwd ?? process.cwd(), id, listDeps);
  return raw ? parseBeadsRecord(raw) : null;
}

/**
 * Daemon-routed `bd list --all --json --limit 0` → all parsed records.
 *
 * Aggregate read — use only when an operation genuinely needs the whole set
 * (sync/backfill reconcile, dedupe, drift, scout dep-graph). For a single-id
 * lookup use {@link showBeadViaDaemon} instead.
 */
export async function loadAllBeadsViaDaemon(deps: FrontDeskReadDeps = {}): Promise<BeadsRecord[]> {
  const { cwd, ...listDeps } = deps;
  return parseBeadsRecords(frontDeskBeadsRaw(cwd ?? process.cwd(), listDeps));
}
