import { getEnv } from "@bounded-systems/env";

/**
 * GH-2078 / epic ai-home-udqx2 (GH-2074) PR-1 — `PRX_TRACE=1` measurement
 * substrate.
 *
 * `traceMs` brackets a single IO call (a `gh issue view`, a `bd show`, a
 * `git ls-remote`, …), measures wall time, and — only when tracing is
 * enabled — emits one JSONL record to stderr. The record shape is locked by
 * `docs/perf/validate-work-session.md`:
 *
 *   {"ts":"2026-05-19T17:23:01.310Z","kind":"gh-issue-view","target":"GH-1960","ms":612,"cache":"miss"}
 *
 * Default (`PRX_TRACE` unset / "0") is silent: `traceMs` runs the wrapped fn
 * and returns its result with no emission and no behavior change. Emission
 * goes to stderr so `--format=json` stdout payloads stay clean — same
 * precedent as `runStep` in `session-progress.ts`.
 *
 * NOTE (.1.4): the helper bodies below are implemented (ai-home-udqx2.5) and
 * `test/pr-state/trace.test.ts` now passes. The remaining `.1.4` scope — wiring
 * these into `github.ts`'s per-call sites — needs a *synchronous* trace path
 * (`CommandRunner` is sync, `traceMs` is async) and is tracked separately; the
 * baseline capture is `.1.5` (ai-home-udqx2.6).
 */

/** Cache disposition recorded for a traced IO call. */
export type TraceCache = "hit" | "miss" | "n/a";

/**
 * Trace label. Left open (`string`) on purpose: .1.4 owns which vocabulary the
 * call sites pass. The per-subprocess kinds enumerated in .1.2 acceptance
 * (`gh-issue-view`, `bd-show`, `gh-api-project`, `gh-pr-list`, `git-ls-remote`,
 * `git-branch`, `wt-status`) are the expected values, but pinning them as a
 * closed union here would pre-empt the wiring step (.1.4) and conflict with the
 * boundary-name kinds illustrated in `docs/perf/validate-work-session.md`.
 */
export type TraceKind = string;

/**
 * One JSONL trace record. The declaration order of these keys is the locked
 * emission order (`docs/perf/validate-work-session.md`).
 */
export interface TraceEvent {
  /** ISO-8601 instant the traced call began. */
  ts: string;
  kind: TraceKind;
  /** Unit id / url / branch the call was about. */
  target: string;
  /** Wall-clock elapsed, ms. */
  ms: number;
  cache: TraceCache;
}

export type TraceMsOptions = {
  /** Cache disposition to record. Default `"n/a"`. */
  cache?: TraceCache;
  /** stderr sink. Defaults to `process.stderr.write`. */
  write?: (line: string) => void;
  /** Current epoch-ms clock. Injected for tests. */
  now?: () => number;
  /** Force enable/disable. Default: `PRX_TRACE === "1"`. */
  enabled?: boolean;
};

/** Whether tracing is on by default (`PRX_TRACE=1`). */
export function traceEnabled(): boolean {
  return getEnv("PRX_TRACE") === "1";
}

/** Default stderr sink — isolated so callers/tests can override it cleanly. */
function writeStderr(line: string): void {
  process.stderr.write(line);
}

/**
 * Serialize one event to a JSONL line (with trailing newline), in the locked
 * `{ts, kind, target, ms, cache}` key order. The object literal below is the
 * single source of that order — `JSON.stringify` preserves insertion order, so
 * the emitted keys never drift from `docs/perf/validate-work-session.md`.
 */
export function formatTraceEvent(event: TraceEvent): string {
  return `${JSON.stringify({
    ts: event.ts,
    kind: event.kind,
    target: event.target,
    ms: event.ms,
    cache: event.cache,
  })}\n`;
}

/**
 * Aggregate traced events into one JSONL summary line — the line `runStep`
 * emits on exit when tracing is enabled. `kind:"summary"` distinguishes it from
 * per-call records; `calls` and `ms` roll up the bracketed phase.
 */
export function formatTraceSummary(events: TraceEvent[]): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    kind: "summary",
    calls: events.length,
    ms: events.reduce((total, event) => total + event.ms, 0),
  })}\n`;
}

/**
 * Run `fn`, measure it, and — when tracing is enabled — emit one JSONL trace
 * record to the stderr sink. Always returns `fn`'s result unchanged; tracing
 * is observation-only. The record is emitted in a `finally`, so a traced call
 * that throws is still attributed (a slow failing call is exactly what the
 * baseline needs to surface).
 */
export async function traceMs<T>(
  kind: TraceKind,
  target: string,
  fn: () => Promise<T>,
  opts: TraceMsOptions = {},
): Promise<T> {
  const enabled = opts.enabled ?? traceEnabled();
  const now = opts.now ?? Date.now;
  const start = now();
  try {
    return await fn();
  } finally {
    if (enabled) {
      const event: TraceEvent = {
        ts: new Date(start).toISOString(),
        kind,
        target,
        ms: now() - start,
        cache: opts.cache ?? "n/a",
      };
      (opts.write ?? writeStderr)(formatTraceEvent(event));
    }
  }
}

/**
 * Synchronous sibling of {@link traceMs} for the synchronous `CommandRunner`
 * seam (`github.ts`). When tracing is disabled this **early-returns** the call
 * with zero added work — no clock read, no `try`/`finally` — so PR-1's
 * "no behavior change when `PRX_TRACE` is off" invariant holds on the hot path.
 */
export function traceSync<T>(
  kind: TraceKind,
  target: string,
  fn: () => T,
  opts: TraceMsOptions = {},
): T {
  const enabled = opts.enabled ?? traceEnabled();
  if (!enabled) return fn();
  const now = opts.now ?? Date.now;
  const start = now();
  try {
    return fn();
  } finally {
    const event: TraceEvent = {
      ts: new Date(start).toISOString(),
      kind,
      target,
      ms: now() - start,
      cache: opts.cache ?? "n/a",
    };
    (opts.write ?? writeStderr)(formatTraceEvent(event));
  }
}

/**
 * Classify a `CommandRunner` argv into the trace `{kind, target}` pair the
 * runner wedge records. Kinds mirror the per-call table validated in `.1.2`
 * (`docs/perf/validate-work-session.audit.md`). `target` is best-effort
 * informational context (issue id / bd id / branch / ref), never load-bearing.
 */
export function classifyTraceCmd(cmd: readonly string[]): {
  kind: TraceKind;
  target: string;
} {
  const [bin, ...rest] = cmd;
  if (bin === "gh") {
    if (rest[0] === "issue" && rest[1] === "view") {
      return { kind: "gh-issue-view", target: rest[2] ?? "" };
    }
    if (rest[0] === "pr" && rest[1] === "list") {
      const headIdx = rest.indexOf("--head");
      return {
        kind: "gh-pr-list",
        target: headIdx >= 0 ? (rest[headIdx + 1] ?? "") : "",
      };
    }
    if (rest[0] === "api") return { kind: "gh-api", target: rest[1] ?? "" };
    return { kind: `gh-${rest[0] ?? "?"}`, target: "" };
  }
  if (bin === "bd") {
    if (rest[0] === "show") return { kind: "bd-show", target: rest[1] ?? "" };
    return { kind: `bd-${rest[0] ?? "?"}`, target: "" };
  }
  if (bin === "git") {
    // Skip a leading `-C <repo>` so the subcommand is classified, not the flag.
    let i = 0;
    let repo = "";
    if (rest[0] === "-C") {
      repo = rest[1] ?? "";
      i = 2;
    }
    const sub = rest[i] ?? "";
    const args = rest.slice(i + 1);
    return { kind: `git-${sub}`, target: args[args.length - 1] ?? repo };
  }
  return { kind: bin ?? "exec", target: "" };
}
