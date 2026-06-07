// GH-296 / prx-lzw — the correctness core of the bd→GH push-leg short-circuit.
//
// The reconcile push leg (bd → GitHub, `gh issue edit`) is bd-authoritative: if
// the bead store hasn't moved since the last SUCCESSFUL push, there is nothing
// to push, so the whole push leg — and its GitHub write requests — can be
// skipped. The freshness signal is the daemon's dataset etag (the served clone's
// dolt HEAD; see beadsd `etag`), which is content-addressed and cheap.
//
// These are pure decisions, isolated from `runBeadsSync` and from IO, because
// the subtle part is RETRY-SAFETY: a failed or partial (`--limit`-deferred) push
// must NOT advance the watermark, or a transient failure would be silently
// skipped forever. Tested here; the run loop just calls them.

/**
 * Should the bd→GH push leg be skipped this tick? Skip iff the bead store is
 * provably unchanged since the last successful push — i.e. both the current
 * dataset etag and the recorded watermark are known and equal. Any unknown
 * (no etag wired, or no prior successful push) ⇒ do not skip (run the push).
 */
export function shouldSkipPush(
  currentHead: string | undefined,
  lastPushedHead: string | undefined,
): boolean {
  return (
    currentHead !== undefined &&
    lastPushedHead !== undefined &&
    currentHead === lastPushedHead
  );
}

/** A push leg's outcome, as it bears on the watermark. */
export type PushOutcome = {
  /** Pairs deferred this tick (e.g. by `--limit`); >0 ⇒ not everything was pushed. */
  pushDeferred: number;
  /** Per-pair push errors this tick; >0 ⇒ not everything succeeded. */
  pushErrors: number;
};

/** True iff the push leg pushed every eligible pair with no errors and no deferrals. */
export function pushFullySucceeded(outcome: PushOutcome): boolean {
  return outcome.pushDeferred === 0 && outcome.pushErrors === 0;
}

/**
 * The watermark to persist after a push attempt. RETRY-SAFE: advance to the
 * current etag only when the push fully succeeded; otherwise keep the previous
 * watermark so the next tick re-attempts (a failed/partial push is not skipped).
 * Also keeps the previous value when the current etag is unknown (can't prove
 * freshness ⇒ don't claim it).
 */
export function advanceLastPushedHead(opts: {
  previous: string | undefined;
  currentHead: string | undefined;
  outcome: PushOutcome;
}): string | undefined {
  if (opts.currentHead !== undefined && pushFullySucceeded(opts.outcome)) {
    return opts.currentHead;
  }
  return opts.previous;
}
