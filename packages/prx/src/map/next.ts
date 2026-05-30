// `prx map next` — surface the highest-leverage ready ticket across all
// maps (or within one when `--map <name>` is passed).
//
// PR-1 stub: ships the actor input/output shapes and reuses the `MapStubError`
// from `./sync.ts`. Real ranking (combine `.prx/maps/*.json` with `bd ready
// --json`, return deterministic order by map name + gate-before-impl) lands in
// the PR-3 child of GH-2016. Cross-map ranking heuristics are intentionally
// deferred per the GH-2016 plan's "Out of scope" list.

import { z } from "zod";

import { MapStubError } from "./sync.ts";

export const mapNextOptionsSchema = z.object({
  /**
   * When set, restrict the picker to a single map's sequence. When absent,
   * walk every `.prx/maps/<name>.json` and return the per-map picks.
   */
  map: z.string().min(1).optional(),
  repoRoot: z.string().min(1),
});
export type MapNextOptions = z.infer<typeof mapNextOptionsSchema>;

export type MapNextPick = {
  mapName: string;
  ticketId: string | null;
  reason: string;
};

export type MapNextActorResult = {
  picks: MapNextPick[];
};

export async function runMapNext(_opts: MapNextOptions): Promise<MapNextActorResult> {
  // PR-3 child of GH-2016 implements the per-map ranking.
  throw new MapStubError("next", "GH-2016");
}
