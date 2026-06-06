import { describe, expect, test } from "bun:test";

import {
  openLimaBeadsChannel,
  provisionBeadsd,
  stopBeadsd,
  withLimaBeadsClient,
} from "../../src/beadsd/lima.ts";
import type { BeadsdLifecycleDeps, LimaBeadsChannelDeps, RunResult } from "../../src/beadsd/lima.ts";
import type { BeadsTransport } from "../../src/beadsd/client.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

const OPTS = { vm: "myvm", vmSocket: "/vm/beadsd.sock", hostSocket: "/tmp/beadsd-host.sock" };

function recorder() {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    if (cmd === "limactl") return ok("Host lima-myvm\n  Port 50348\n");
    return ok();
  };
  return { calls, run };
}

/** A fake transport that answers any beads request with a fixed ok result. */
const fakeTransport: BeadsTransport = async () => ({ status: "ok", result: [{ id: "prx-abb" }] });

function deps(): LimaBeadsChannelDeps & { calls: { cmd: string; args: string[] }[] } {
  const { calls, run } = recorder();
  return { calls, run, exists: () => true, sleep: async () => {}, makeTransport: () => fakeTransport };
}

describe("withLimaBeadsClient", () => {
  test("runs fn with an IsolatedBeadsClient over the channel, then closes the forward", async () => {
    const d = deps();
    const res = await withLimaBeadsClient(OPTS, (client) => client.query({ kind: "ready" }), d);

    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.result).toEqual([{ id: "prx-abb" }]);
    // the forward was bridged to the beadsd VM socket and torn down (-O exit)
    const fwd = d.calls.find((c) => c.cmd === "ssh" && c.args.includes("-L"))!;
    expect(fwd.args).toContain("/tmp/beadsd-host.sock:/vm/beadsd.sock");
    expect(d.calls.some((c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit"))).toBe(true);
  });

  test("closes the forward even when fn throws", async () => {
    const d = deps();
    await expect(
      withLimaBeadsClient(OPTS, async () => {
        throw new Error("boom");
      }, d),
    ).rejects.toThrow("boom");
    expect(d.calls.some((c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit"))).toBe(true);
  });
});

describe("openLimaBeadsChannel", () => {
  test("hands back a beads-typed channel whose client query works", async () => {
    const d = deps();
    const ch = await openLimaBeadsChannel(OPTS, d);
    try {
      expect(ch.hostSocket).toBe("/tmp/beadsd-host.sock");
      expect(ch.transport).toBe(fakeTransport);
    } finally {
      await ch.close();
    }
  });
});

// ── lifecycle: beadsd up/down in the VM ──────────────────────────────────────

const ok2 = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const script = (args: string[]) => args[args.length - 1] ?? "";

function lifecycleRecorder() {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return ok2();
  };
  return { calls, run };
}

describe("provisionBeadsd / stopBeadsd", () => {
  test("provisions: deploys prx, launches `beads serve` on /tmp/beadsd.sock, no provenance env", async () => {
    const { calls, run } = lifecycleRecorder();
    const deps: BeadsdLifecycleDeps = { run, sleep: async () => {} };
    const handle = await provisionBeadsd(
      { vm: "myvm", binaryPath: "dist/prx-linux-arm64", cwd: "/vm/clone" },
      deps,
    );

    expect(handle.socket).toBe("/tmp/beadsd.sock");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"] });
    const launch = script(calls.find((c) => script(c.args).includes("beads serve"))!.args);
    expect(launch).toContain(
      "setsid nohup /tmp/prx beads serve --socket /tmp/beadsd.sock --cwd /vm/clone --pidfile /tmp/beadsd.pid",
    );
    // beadsd is read-only — no provenance/signing key is ever injected.
    expect(launch).not.toContain("PRX_PROVENANCE_KEY");
  });

  test("stops by pidfile and removes socket/log/pidfile (no pkill)", async () => {
    const { calls, run } = lifecycleRecorder();
    await stopBeadsd({ vm: "myvm" }, { run });
    const s = script(calls[0]!.args);
    expect(s).toContain("cat /tmp/beadsd.pid");
    expect(s).toContain("rm -f /tmp/beadsd.sock /tmp/beadsd.log /tmp/beadsd.pid");
    expect(s).not.toContain("pkill");
  });
});
