// The SYNC AGENT (prx-697) — a periodic driver over the existing cross-repo
// reconcile orchestrators. It owns cross-repo beads DURABILITY: every tick it
// runs the domain↔GH sync (`runBeadsSyncAcrossRepos`, GH-1662) then the dolt
// reconcile (`runDoltReconcileAcrossRepos`, GH-1702) over the repo inventory.
//
// This is NOT new reconcile logic — the primitives + orchestrators (with their
// cursor + GH-API budget + per-repo isolation + schema-conflict handling) already
// exist and are tested. The agent is just the timer loop above them, the blocking
// prerequisite for prx-82b (remove host bd) — once the agent owns durability, the
// host-native daemon can be retired.
//
// Shape: a long-running daemon (`prx sync serve`), mirroring beadsd's
// `runBeadsServe` (interval + graceful shutdown). It runs host-global (cross-repo),
// so it's a standalone agent — not a per-repo-pod member. No socket in v1: it's a
// periodic orchestrator, not a request daemon (a status door is a later refinement).

import { writeFileSync, rmSync } from "node:fs";

/** Where pass output goes (mirrors the orchestrators' `output` shape). */
export interface SyncServeOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Default tick interval — 5 min, matching the per-repo beadsd refresh cadence. */
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;

/** Injectable seams. The two passes are required (the verb supplies the real
 *  orchestrator-backed ones — see serve-verb.ts; tests supply fakes); the rest
 *  default to the wall clock / fs / process signals. */
export interface SyncServeDeps {
  /** The domain↔GH cross-repo pass (e.g. `runBeadsSyncAcrossRepos` over all repos). */
  beadsSyncPass: (output: SyncServeOutput) => Promise<{ exitCode: number }>;
  /** The dolt reconcile cross-repo pass (e.g. `runDoltReconcileAcrossRepos` full). */
  doltReconcilePass: (output: SyncServeOutput) => Promise<{ exitCode: number }>;
  /** `setInterval` seam (test injection). */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** `clearInterval` seam (test injection). */
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  /** Install the shutdown handler (default: process SIGTERM/SIGINT; test: no-op). */
  onSignal?: (stop: () => void) => void;
  /** Write the pidfile (default: `writeFileSync`). */
  writePidfile?: (path: string, pid: number) => void;
  /** Remove the pidfile (default: `rmSync`, best-effort). */
  removePidfile?: (path: string) => void;
}

export interface SyncServeOptions {
  /** Interval between cross-repo passes (default {@link DEFAULT_SYNC_INTERVAL_MS}). */
  intervalMs?: number | undefined;
  /** Write the daemon pid here on start; removed on stop (launcher-trackable). */
  pidfile?: string | undefined;
  output?: SyncServeOutput | undefined;
  /** The reconcile passes (+ optional clock/fs/signal seams). Required. */
  deps: SyncServeDeps;
}

export interface SyncServeHandle {
  /** Resolves when the daemon stops (signal or {@link SyncServeHandle.stop}). */
  closed: Promise<void>;
  /** Stop the loop and resolve {@link SyncServeHandle.closed}. */
  stop: () => void;
  /** Run one cross-repo pass now (also the on-start pass). Exposed for tests. */
  tick: () => Promise<void>;
}

/**
 * Run the sync agent: an on-start pass then one every `intervalMs`. Each pass is
 * best-effort — the orchestrators already self-isolate per-repo failures, and a
 * pass-level throw is swallowed + logged (a stale-but-up agent beats a crash,
 * like beadsd's refresh). Returns a handle whose `closed` resolves on shutdown.
 */
export async function runSyncServe(options: SyncServeOptions): Promise<SyncServeHandle> {
  const output: SyncServeOutput = options.output ?? {
    log: (line) => console.error(line),
    error: (line) => console.error(line),
  };
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const deps = options.deps;
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((handle) => clearInterval(handle));
  const beadsSyncPass = deps.beadsSyncPass;
  const doltReconcilePass = deps.doltReconcilePass;

  const tick = async (): Promise<void> => {
    try {
      const r = await beadsSyncPass(output);
      output.log(`sync: beads cross-repo pass done (exit ${r.exitCode})`);
    } catch (e) {
      output.error(`sync: beads pass failed (continuing): ${(e as Error).message}`);
    }
    try {
      const r = await doltReconcilePass(output);
      output.log(`sync: dolt reconcile pass done (exit ${r.exitCode})`);
    } catch (e) {
      output.error(`sync: dolt pass failed (continuing): ${(e as Error).message}`);
    }
  };

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let handle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const removePidfile = deps.removePidfile ?? ((p) => rmSync(p, { force: true }));
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) clearI(handle);
    if (options.pidfile) {
      try {
        removePidfile(options.pidfile);
      } catch {
        // best-effort — a leftover pidfile is harmless
      }
    }
    resolveClosed();
  };

  if (options.pidfile) {
    const writePidfile = deps.writePidfile ?? ((p, pid) => writeFileSync(p, `${pid}\n`));
    writePidfile(options.pidfile, process.pid);
  }

  if (deps.onSignal) {
    deps.onSignal(stop);
  } else {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  // On-start pass, then schedule the recurring tick.
  await tick();
  handle = setI(() => {
    void tick();
  }, intervalMs);

  return { closed, stop, tick };
}
