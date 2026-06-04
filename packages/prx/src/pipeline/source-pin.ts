/**
 * Work-unit source pin (prx-adj, epic prx-997).
 *
 * The provenance chain (`plan@ → implement@latest → commit/v1 → checks/v1 →
 * push/v1`) referenced a unit by id but never content-anchored its *source* —
 * the GH issue / beads row / Notion ticket that is the unit's authority. This
 * pins that source as the chain ROOT: `<unit>:source@pinned`.
 *
 * It is the Nix fixed-output-derivation bridge ({@link pinSource}) applied to the
 * issue: the impure read (the resolver fetch) is hashed and pinned by content,
 * so the chain is anchored to the *exact issue text* at the moment it entered.
 * {@link workUnitSourceFresh} ({@link isFresh}) makes drift observable — `fresh:
 * false` means the upstream issue was edited since the pin.
 *
 * Persistence is `"git"` because the source lives in an external system (a
 * git-hosted issue / a dolt-backed bead), not the CAS — exactly the FOD case the
 * edge primitive was built for.
 */
import { z } from "zod";

import type { ResolvedWorkUnit } from "../pr-state/resolvers/types.ts";

import {
  type ArtifactEdge,
  type EmitResult,
  type FreshnessResult,
  defineEdge,
  isFresh,
  pinSource,
} from "./edge.ts";

/** The schema for a pinned source — the resolver's {@link ResolvedWorkUnit}. */
export const resolvedSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed", "unknown"]),
  url: z.string().nullable(),
  source: z.enum(["github", "notion", "beads"]),
});
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;

/** The source edge: the issue/bead authority pinned at the head of the chain. */
export const workUnitSourceEdge: ArtifactEdge<ResolvedSource> = defineEdge({
  kind: "source",
  slot: "pinned",
  source: "issue",
  target: "intake",
  persistence: "git",
  schema: resolvedSourceSchema,
});

/**
 * Pin a unit's resolved source authority to `<unit>:source@pinned`. The resolved
 * value is already fetched (the gate resolved it), so the FOD `fetch` just
 * returns it — the pin hashes + stores its content.
 */
export function pinWorkUnitSource(
  unit: string,
  resolved: ResolvedWorkUnit,
): Promise<EmitResult> {
  return pinSource(workUnitSourceEdge, unit, () => resolved);
}

/**
 * Whether the live source still matches what was pinned for `unit`. `fresh:
 * false` ⇒ the upstream issue/bead drifted since the pin (re-pin to refresh).
 */
export function workUnitSourceFresh(
  unit: string,
  resolved: ResolvedWorkUnit,
): Promise<FreshnessResult> {
  return isFresh(workUnitSourceEdge, unit, () => resolved);
}

/**
 * Best-effort pin used at authority resolution: a CAS write failure must never
 * break session entry, so a throw is swallowed and reported as `pinned: false`.
 */
export async function pinWorkUnitSourceBestEffort(
  unit: string,
  resolved: ResolvedWorkUnit,
): Promise<{ pinned: boolean; ref: string }> {
  try {
    const { ref } = await pinWorkUnitSource(unit, resolved);
    return { pinned: true, ref };
  } catch {
    return { pinned: false, ref: "" };
  }
}
