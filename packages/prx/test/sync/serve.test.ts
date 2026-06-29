import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSyncServe, DEFAULT_SYNC_INTERVAL_MS, type SyncServeOutput } from "../../src/sync/serve.ts";

const SAFE_PASSES = {
  beadsSyncPass: async () => ({ exitCode: 0 }),
  doltReconcilePass: async () => ({ exitCode: 0 }),
};

function collectOutput(): SyncServeOutput & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (l) => lines.push(l), error: (e) => errors.push(e) };
}

describe("runSyncServe — the sync-agent loop (prx-697)", () => {
  test("runs both passes once on start, then again on each interval tick", async () => {
    let beads = 0;
    let dolt = 0;
    let intervalFn: (() => void) | null = null;
    let scheduledMs = 0;
    const out = collectOutput();

    const handle = await runSyncServe({
      intervalMs: 1000,
      output: out,
      deps: {
        beadsSyncPass: async () => {
          beads++;
          return { exitCode: 0 };
        },
        doltReconcilePass: async () => {
          dolt++;
          return { exitCode: 0 };
        },
        setInterval: (fn, ms) => {
          intervalFn = fn;
          scheduledMs = ms;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => {},
        onSignal: () => {},
      },
    });

    // On-start pass.
    expect(beads).toBe(1);
    expect(dolt).toBe(1);
    expect(scheduledMs).toBe(1000);

    // Fire the interval tick twice.
    await intervalFn!();
    await intervalFn!();
    expect(beads).toBe(3);
    expect(dolt).toBe(3);
    expect(out.lines.some((l) => l.includes("beads cross-repo pass done"))).toBe(true);
    expect(out.lines.some((l) => l.includes("dolt reconcile pass done"))).toBe(true);

    handle.stop();
    await handle.closed;
  });

  test("a thrown pass is swallowed — the other pass still runs and the loop survives", async () => {
    let dolt = 0;
    const out = collectOutput();

    const handle = await runSyncServe({
      output: out,
      deps: {
        beadsSyncPass: async () => {
          throw new Error("boom");
        },
        doltReconcilePass: async () => {
          dolt++;
          return { exitCode: 0 };
        },
        setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {},
        onSignal: () => {},
      },
    });

    // beads threw, but dolt still ran and runSyncServe did not reject.
    expect(dolt).toBe(1);
    expect(out.errors.some((e) => e.includes("beads pass failed") && e.includes("boom"))).toBe(true);

    handle.stop();
    await handle.closed;
  });

  test("stop() clears the interval and resolves closed (idempotent)", async () => {
    let cleared = 0;
    const handle = await runSyncServe({
      deps: {
        beadsSyncPass: async () => ({ exitCode: 0 }),
        doltReconcilePass: async () => ({ exitCode: 0 }),
        setInterval: () => 42 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {
          cleared++;
        },
        onSignal: () => {},
      },
    });

    handle.stop();
    handle.stop(); // idempotent — no double clear
    await handle.closed; // resolves
    expect(cleared).toBe(1);
  });

  test("the shutdown handler is wired to stop", async () => {
    let registered: (() => void) | null = null;
    const handle = await runSyncServe({
      deps: {
        beadsSyncPass: async () => ({ exitCode: 0 }),
        doltReconcilePass: async () => ({ exitCode: 0 }),
        setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {},
        onSignal: (stop) => {
          registered = stop;
        },
      },
    });
    expect(typeof registered).toBe("function");
    registered!(); // simulate SIGTERM
    await handle.closed; // the signal stopped the loop
  });

  test("writes the pidfile on start and removes it on stop", async () => {
    const written: Array<{ path: string; pid: number }> = [];
    const removed: string[] = [];
    const handle = await runSyncServe({
      pidfile: "/tmp/prx-sync.pid",
      deps: {
        beadsSyncPass: async () => ({ exitCode: 0 }),
        doltReconcilePass: async () => ({ exitCode: 0 }),
        setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {},
        onSignal: () => {},
        writePidfile: (path, pid) => written.push({ path, pid }),
        removePidfile: (path) => removed.push(path),
      },
    });
    expect(written).toEqual([{ path: "/tmp/prx-sync.pid", pid: process.pid }]);
    handle.stop();
    await handle.closed;
    expect(removed).toEqual(["/tmp/prx-sync.pid"]);
  });

  test("real defaults: wires the wall-clock timer, process signals, and fs pidfile", async () => {
    // Exercise the default setInterval/clearInterval/onSignal/writePidfile/
    // removePidfile seams (injected passes keep it offline + side-effect-free).
    const dir = mkdtempSync(join(tmpdir(), "prx-sync-"));
    const pidfile = join(dir, "agent.pid");
    try {
      const handle = await runSyncServe({
        intervalMs: 60 * 60_000, // far in the future — never fires during the test
        pidfile,
        deps: { ...SAFE_PASSES },
      });
      expect(existsSync(pidfile)).toBe(true);
      handle.stop();
      await handle.closed;
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DEFAULT_SYNC_INTERVAL_MS is 5 minutes (matches beadsd refresh)", () => {
    expect(DEFAULT_SYNC_INTERVAL_MS).toBe(5 * 60_000);
  });
});
