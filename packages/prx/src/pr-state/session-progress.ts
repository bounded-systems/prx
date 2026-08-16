import { getEnv } from "@bounded-systems/env";
/**
 * GH-2014: per-phase progress wrapper for `primePlanSession`.
 *
 * The pre-claude orchestration runs several network-bound steps back to back
 * (`validateWorkSessionEntry`, `materializeWorktree`, `autoRebaseOnSessionOpen`,
 * `hydrateBeads`, `ensureLocalRuntimeArtifacts`, `ensureClaudeInteractiveAllowlist`).
 * In the silent case the operator cannot distinguish "still working" from
 * "hung". `runStep` brackets each phase with a start banner and a finish line,
 * and ticks a heartbeat every `heartbeatMs` while the work is in flight, so
 * there is never a >5s silent window.
 *
 * Writes go to stderr (parity with the rest of `primePlanSession`'s warnings
 * — the JSON payload, when present, lives on stdout). The clock is injected
 * so tests stub it instead of waiting wall-clock seconds.
 */

export type RunStepOptions = {
  /** Heartbeat cadence in ms (default 5000). */
  heartbeatMs?: number;
  /** Stderr sink. Defaults to `process.stderr.write`. */
  write?: (line: string) => void;
  /**
   * When true, suppress all writes. Used by `--format=json` callers so the
   * stdout JSON payload stays clean and stderr stays free of progress noise
   * in scripted invocations.
   */
  silent?: boolean;
  /** Returns the current time in ms. Injected for tests. */
  now?: () => number;
  /** Test seam: replace `setInterval` with a stub. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Test seam: matching clear for {@link setInterval}. */
  clearInterval?: (handle: unknown) => void;
};

const DEFAULT_HEARTBEAT_MS = 5000;

export async function runStep<T>(
  name: string,
  fn: () => Promise<T>,
  opts: RunStepOptions = {},
): Promise<T> {
  const write = opts.write ?? ((line) => process.stderr.write(line));
  // prx-j4a: the per-step ▸/✓ noise is off by default — the agents narrate their
  // outcome through the structured result (input-artifact → output-artifact via
  // `emit`), not a play-by-play. Opt back into the live step log + heartbeat with
  // PRX_PROGRESS=1 (e.g. when a long step looks hung).
  const autoSilent = getEnv("PRX_PROGRESS") !== "1";
  const silent = opts.silent ?? autoSilent;
  const now = opts.now ?? (() => Date.now());
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setIntervalFn = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const start = now();
  if (!silent) write(`▸ ${name}\n`);
  let handle: unknown | undefined;
  if (!silent && heartbeatMs > 0) {
    handle = setIntervalFn(() => {
      const elapsedSec = Math.round((now() - start) / 1000);
      write(`  …still running (${elapsedSec}s elapsed)\n`);
    }, heartbeatMs);
  }
  try {
    const result = await fn();
    const elapsed = now() - start;
    if (!silent) write(`✓ ${name} (${elapsed}ms)\n`);
    return result;
  } catch (err) {
    const elapsed = now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (!silent) write(`✗ ${name} (${elapsed}ms): ${message}\n`);
    throw err;
  } finally {
    if (handle !== undefined) clearIntervalFn(handle);
  }
}
