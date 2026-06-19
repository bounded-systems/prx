import { processEnv } from "@bounded-systems/env";
/**
 * Resolve the active work-unit id for plan toolset verbs (GH-1311).
 *
 * NOT to be confused with `src/pr-state/help/session-context.ts` — that file
 * resolves a SessionContext enum (`mainx | plan | intake | triage | implement`)
 * for help-surface §6.2 promoted-set selection. THIS file resolves a concrete
 * work-unit id (e.g. `GH-1311`) for `prx plan save / load / show / view /
 * search` so those verbs can run from inside an open `prx plan session GH-N`
 * pane without re-typing `--unit GH-N`.
 *
 * Resolution order:
 *   1. explicit `--unit` flag value           → source: "flag"
 *   2. PRX_PLAN_SESSION_UNIT env var          → source: "session"
 *      (set by buildOpsPlanClaudeRuntimeProfile in runtime_profiles.ts)
 *   3. cwd/branch detection via injected      → source: "detected"
 *      detector (wraps detectWorkCommandTarget)
 *   4. nothing                                → source: "missing"
 *
 * The resolver wraps `detectWorkCommandTarget` (passed via DI to avoid a
 * circular import on src/pr-state/cli.ts), it never replaces it. Callers
 * decide whether to validate flag-source values against the canonical-id
 * pattern.
 *
 * Detection gate: `detectWorkCommandTarget` always returns a non-empty
 * `workUnitId` — even when it can't infer a canonical id (e.g. on `main`
 * it returns `{ workUnitId: "main", launchFromCurrentWorkspace: true }`).
 * The resolver treats `launchFromCurrentWorkspace === true` as `"missing"`
 * rather than `"detected"` so toolset verbs don't silently target bogus
 * refs like `main` or a worktree basename. Operators must run from a
 * canonical worktree, set PRX_PLAN_SESSION_UNIT, or pass --unit.
 */

export type ResolvedPlanUnit =
  | { readonly unit: string; readonly source: "flag" | "session" | "detected" }
  | { readonly unit: null; readonly source: "missing" };

export type PlanUnitDetector = (cwd?: string) => {
  workUnitId: string;
  launchFromCurrentWorkspace: boolean;
};

export type ResolvePlanSessionUnitDeps = {
  env?: NodeJS.ProcessEnv;
  detect?: PlanUnitDetector;
};

export function resolvePlanSessionUnit(
  explicit: string | undefined,
  deps: ResolvePlanSessionUnitDeps = {},
): ResolvedPlanUnit {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return { unit: explicit.trim(), source: "flag" };
  }

  const env = deps.env ?? processEnv();
  const fromEnv = env.PRX_PLAN_SESSION_UNIT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { unit: fromEnv.trim(), source: "session" };
  }

  const detect = deps.detect;
  if (detect) {
    const detected = detect();
    // Gate on `launchFromCurrentWorkspace === false`: the detector's
    // fallback returns the cwd basename or branch name (e.g. "main") with
    // the flag set to `true`, which is NOT a valid canonical unit. Treat
    // those as missing so the caller surfaces a clean error instead of
    // silently routing to a bogus ref.
    if (
      detected.launchFromCurrentWorkspace === false &&
      typeof detected.workUnitId === "string" &&
      detected.workUnitId.length > 0
    ) {
      return { unit: detected.workUnitId, source: "detected" };
    }
  }

  return { unit: null, source: "missing" };
}
