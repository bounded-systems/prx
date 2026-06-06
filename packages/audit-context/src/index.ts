// GH-1533 — ambient runtime context for `gh`-call audit attribution.
//
// The GH-1141 `withBucketGate` wrapper (`src/github/rate-limit.ts`) is the
// single chokepoint every `gh` invocation passes through, but it has no
// argument carrying *which prx verb* issued the call. `runCli` sets the verb
// here once (right after `parseCommand`) and the wrapper reads it back to
// stamp `verb`/`actor` onto the `~/.cache/prx/github/rate-limit.jsonl` row.
// Process-global by design: there is one prx process per CLI invocation, and
// the alternative (threading a verb argument through every `gh`-touching call
// site) is far more invasive for no benefit.
//
// When the gated runner is used outside `runCli` (a test harness, a long-lived
// daemon), `verb` stays `null` — attribution then falls back to `argv` + `ts`.
//
// GH-1602 adds a third ambient slot, `ghTruthReason`. Once `prx triage` moved
// its read aperture from `gh issue list` to the bd substrate, the only
// remaining gh calls in triage are the comparators that NEED a gh-side
// answer (forward-orphan / drift / stale). `withGhTruthReason` lets a caller
// declare "this gh call is load-bearing because of <reason>" — the wrapper
// stamps it onto the row so the audit log can distinguish a justified gh
// comparator from an accidental gh fallback that the triage refactor missed.

export type GhTruthReason =
  | "forward-orphan-detection"
  | "drift-comparator"
  | "stale-comparator";

let currentVerb: string | null = null;
let currentActor = "claude-code";
let currentGhTruthReason: GhTruthReason | null = null;
// GH-352: the dispatch *source* — the actor that initiated this run when it is a
// leg-dispatched subprocess (e.g. `implement` dispatching `scout`). Null for a
// direct call (sourced from the human, i.e. `actor`). It is the signing/
// provenance *authority* (who drove the work), distinct from `actor` (the gh-
// audit executor), so it lives in its own slot rather than overloading `actor`.
let currentSource: string | null = null;

export type AuditRuntimeContext = {
  verb: string | null;
  actor: string;
  ghTruthReason: GhTruthReason | null;
  /** The dispatch source (initiating authority), or null for a direct call. */
  source: string | null;
};

export function setAuditRuntimeContext(ctx: {
  verb?: string | null;
  actor?: string;
  source?: string | null;
}): void {
  if (ctx.verb !== undefined) currentVerb = ctx.verb;
  if (ctx.actor !== undefined) currentActor = ctx.actor;
  if (ctx.source !== undefined) currentSource = ctx.source;
}

export function getAuditRuntimeContext(): AuditRuntimeContext {
  return {
    verb: currentVerb,
    actor: currentActor,
    ghTruthReason: currentGhTruthReason,
    source: currentSource,
  };
}

/**
 * Run `fn` with `ghTruthReason` set in the ambient runtime context. Any `gh`
 * call made synchronously inside `fn` lands its rate-limit-audit row tagged
 * with the reason. Nested calls restore the prior value on exit (the more
 * specific reason wins for the duration it's in scope).
 */
export function withGhTruthReason<T>(reason: GhTruthReason, fn: () => T): T {
  const prev = currentGhTruthReason;
  currentGhTruthReason = reason;
  try {
    return fn();
  } finally {
    currentGhTruthReason = prev;
  }
}

/** Test-only: reset to the process-start defaults. */
export function __resetAuditRuntimeContextForTesting(): void {
  currentVerb = null;
  currentActor = "claude-code";
  currentGhTruthReason = null;
  currentSource = null;
}
