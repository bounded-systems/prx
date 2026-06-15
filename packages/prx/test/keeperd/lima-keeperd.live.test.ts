import { describe, expect, test } from "bun:test";

import { spawnRun } from "../../src/door/lima-exec.ts";
import { provisionKeeperd, stopKeeperd } from "../../src/keeperd/lima-keeperd.ts";

/**
 * Opt-in LIVE integration test (GH-223) — exercises the real keeperd lifecycle
 * against a running Lima VM. Skipped unless the operator sets:
 *   PRX_KEEPERD_LIVE_VM     Lima instance name
 *   PRX_KEEPERD_LIVE_CWD    keeper repo clone path INSIDE the VM
 *   PRX_KEEPERD_LIVE_BINARY host Linux prx (default: dist/prx-linux-arm64)
 *
 * It never runs in CI (the env is unset there); it's the loud regression guard
 * for the cross-shell-layer behavior that the mocked unit tests can't catch.
 */
const LIVE_VM = process.env.PRX_KEEPERD_LIVE_VM;
const LIVE_CWD = process.env.PRX_KEEPERD_LIVE_CWD;
const LIVE_BIN = process.env.PRX_KEEPERD_LIVE_BINARY ?? "dist/prx-linux-arm64";

const live = LIVE_VM && LIVE_CWD ? describe : describe.skip;

live("keeperd lifecycle — LIVE (opt-in via PRX_KEEPERD_LIVE_*)", () => {
  test("up deploys+serves (readiness poll passes); down stops by pidfile", async () => {
    const vm = LIVE_VM!;
    const socketLive = () =>
      spawnRun("limactl", ["shell", "--workdir", "/", vm, "--", "test", "-S", "/tmp/keeperd.sock"]).status === 0;

    const handle = await provisionKeeperd({ vm, binaryPath: LIVE_BIN, cwd: LIVE_CWD! });
    expect(handle.socket).toBe("/tmp/keeperd.sock");
    expect(socketLive()).toBe(true); // daemon really bound the socket in the VM

    await stopKeeperd({ vm });
    expect(socketLive()).toBe(false); // stop-by-pidfile removed it
  }, 60_000);
});
