// `prx map sync` — project a {@link MapRecord} into bd as `blocks` /
// `relates_to` edges + priority bumps.
//
// PR-1 stub: ships the actor input/output shapes and the error class so the
// machine wires through `blocked`. Real idempotent projection (bd edge reads
// via `bd dep list --json`, writes via `execBd("dep", ["add", ...])` and
// `execBd("dep", ["relate", ...])`) lands in the PR-2 child of GH-2016.

import { z } from "zod";

import { MapRecord } from "./schemas/index.ts";

export const mapSyncOptionsSchema = z.object({
  /** Map name (resolved to `<repoRoot>/.prx/maps/<name>.json`). */
  name: z.string().min(1),
  /** Defaults to `process.cwd()` in the runner. */
  repoRoot: z.string().min(1),
  /** When true, do not write to bd. */
  dryRun: z.boolean().default(false),
});
export type MapSyncOptions = z.infer<typeof mapSyncOptionsSchema>;

export type MapSyncActorResult = {
  name: string;
  edgesWritten: number;
  edgesSkipped: number;
  record: MapRecord;
};

export class MapStubError extends Error {
  readonly ticket: string;
  readonly verb: string;
  constructor(verb: string, ticket: string) {
    super(`map ${verb}: not implemented — see ${ticket}`);
    this.name = "MapStubError";
    this.ticket = ticket;
    this.verb = verb;
  }
}

export async function runMapSync(_opts: MapSyncOptions): Promise<MapSyncActorResult> {
  // PR-2 child of GH-2016 implements the projection.
  throw new MapStubError("sync", "GH-2016");
}
