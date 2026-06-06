import { describe, expect, test } from "bun:test";

import { openLimaBeadsChannel, withLimaBeadsClient } from "../../src/beadsd/lima.ts";
import type { LimaBeadsChannelDeps, RunResult } from "../../src/beadsd/lima.ts";
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
