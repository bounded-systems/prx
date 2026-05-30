// GH-1828 — Persist a non-interactive agent's accumulated stdout into the
// `<UoW>:plan@draft` CAS slot when a run is cancelled (watchdog or operator).
//
// Drops out of the §3.2 contract (docs/spikes/GH-1827-actor-session-modes.md):
// the operator should be able to run `prx plan view <id> --slot draft` and
// see what the planner produced before cancellation, then resume from the
// saved blob rather than starting over.

import { runPlanSave as defaultRunPlanSave } from "../plan-store/verbs.ts";

import type { DraftSink } from "./agent_service.ts";

export type CapturePartialPlanDeps = {
  /** DI seam — defaults to the canonical `runPlanSave` from plan-store/verbs.ts. */
  runPlanSave?: typeof defaultRunPlanSave;
};

/**
 * Build a {@link DraftSink} closure that writes `partialStdout` into
 * `<workUnitId>:plan@draft`. Returns the saved ref (e.g. `GH-1823:plan@draft`)
 * on success, `null` on any failure (the cancellation path swallows draft
 * errors — losing the draft is a soft failure, the cancellation already
 * carries the operator-visible signal).
 *
 * GH-2028: under persist-on-failure the body always lands; `skipValidate: true`
 * forces the envelope's `validated_ok: true` so a cancelled mid-stream draft is
 * still consumable, matching this sink's documented intent. Any save failure
 * (CAS IO) is still swallowed — losing the draft is a soft failure, the
 * cancellation already carries the operator-visible signal.
 */
export function makeWorkUnitDraftSink(
  workUnitId: string,
  deps: CapturePartialPlanDeps = {},
): DraftSink {
  const save = deps.runPlanSave ?? defaultRunPlanSave;
  return async (partialStdout) => {
    if (partialStdout.trim().length === 0) return null;
    try {
      const saved = await save({
        unit: workUnitId,
        slot: "draft",
        content: partialStdout,
        skipValidate: true,
      });
      return saved.ref;
    } catch {
      return null;
    }
  };
}
