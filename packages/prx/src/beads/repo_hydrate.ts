/**
 * GH-1680: hydrate `.beads/` into a freshly-materialized mainx worktree.
 *
 * Thin wrapper over `hydrate()` (src/beads/hydrate.ts) that names the
 * contract surface `prx repo add` (PR-B) and `prx repo refresh` (PR-C,
 * GH-1681) both share. Lives next to `hydrate.ts` so the wrapper imports
 * siblings rather than back into `pr-state`.
 *
 * Failure policy: callers treat the returned `HydrateResult` as data, not
 * an exception — a `clone-failed` status must NOT roll back a successful
 * bare + mainx materialization (operator recovers via `prx repo refresh
 * <slug>`).
 */

import { hydrate, type HydrateDeps, type HydrateResult } from "./hydrate.ts";

export type { HydrateDeps, HydrateResult };

export function hydrateAfterMaterialize(
  mainxPath: string,
  deps?: HydrateDeps,
  opts?: { dryRun?: boolean },
): HydrateResult {
  return hydrate({ cwd: mainxPath, dryRun: opts?.dryRun }, deps);
}
