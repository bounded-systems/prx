// GH-1012 — the aggregate work-item read, from Front Desk.
//
// Historically this spawned `prx beads list` (which round-tripped through the
// beadsd daemon to bd). Since GH-1017 the daemon's list case already served
// Front Desk, so this now reads Front Desk DIRECTLY via `frontDeskBeadsRaw` —
// dropping the daemon hop entirely (a step toward deleting beadsd + bd). The
// shape (`BeadsRecord[]` via `parseBeadsRecords`) and the SYNC signature are
// unchanged, so the ~24 sync call sites over `BeadsCache.load()` are unaffected.

import { type CommandRunner } from "@bounded-systems/proc";

import { frontDeskBeadsRaw } from "../beads/frontdesk-list.ts";
import { parseBeadsRecords, type BeadsRecord } from "./triage.ts";

export type LoadAllBeadsViaCliDeps = {
  /** Sync command runner, forwarded to `frontDeskBeadsRaw` (git + `fds`). */
  run?: CommandRunner | undefined;
  /** Working directory used to resolve the Front Desk repo (default: process.cwd()). */
  cwd?: string | undefined;
  /** @deprecated no longer used (no `prx` spawn); kept for call-site compatibility. */
  prxBinary?: string | undefined;
  /** @deprecated no longer used (Front Desk reads don't tolerate partial output). */
  warn?: ((line: string) => void) | undefined;
};

/**
 * The aggregate work-item read, from Front Desk (GH-canonical). Synchronous
 * (spawns `fds list`), so it keeps `BeadsCache.load()`'s sync contract.
 */
export function loadAllBeadsViaCli(deps: LoadAllBeadsViaCliDeps = {}): BeadsRecord[] {
  const cwd = deps.cwd ?? process.cwd();
  return parseBeadsRecords(frontDeskBeadsRaw(cwd, deps.run ? { run: deps.run } : {}));
}
