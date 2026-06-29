import { describe, expect, test } from "bun:test";

import { syncServeVerb, type SyncServeVerbDeps } from "../../src/sync/serve-verb.ts";
import { DEFAULT_SYNC_INTERVAL_MS, type SyncServeHandle } from "../../src/sync/serve.ts";

/** A handle whose `closed` resolves on the next tick so run() unblocks. */
function fakeHandle(): SyncServeHandle {
  return {
    closed: new Promise<void>((resolve) => setTimeout(resolve, 0)),
    stop: () => {},
    tick: async () => {},
  };
}

describe("syncServeVerb", () => {
  test("serves at the given interval (seconds → ms), logs, returns the interval", async () => {
    let servedMs: number | undefined;
    let servedPidfile: string | undefined;
    const logs: string[] = [];
    const deps: SyncServeVerbDeps = {
      serve: async (opts) => {
        servedMs = opts?.intervalMs;
        servedPidfile = opts?.pidfile;
        return fakeHandle();
      },
      log: (l) => logs.push(l),
    };

    const out = await syncServeVerb.run({ interval: 60, pidfile: "/tmp/s.pid" }, deps);

    expect(servedMs).toBe(60_000);
    expect(servedPidfile).toBe("/tmp/s.pid");
    expect(logs.some((l) => l.includes("every 60s"))).toBe(true);
    expect(out).toEqual({ intervalSeconds: 60 });
  });

  test("defaults to DEFAULT_SYNC_INTERVAL_MS when --interval is omitted", async () => {
    let servedMs: number | undefined;
    const deps: SyncServeVerbDeps = {
      serve: async (opts) => {
        servedMs = opts?.intervalMs;
        return fakeHandle();
      },
      log: () => {},
    };

    const out = await syncServeVerb.run({}, deps);

    expect(servedMs).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(out.intervalSeconds).toBe(DEFAULT_SYNC_INTERVAL_MS / 1000);
  });

  test("verb id + actor", () => {
    expect(syncServeVerb.id).toBe("sync serve");
  });
});
