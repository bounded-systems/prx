import { describe, expect, test } from "bun:test";

import {
  openLimaChannel,
  withLimaChannel,
  type LimaChannelDeps,
  type RunResult,
} from "../../src/lima/channel.ts";
import type { FramedTransport } from "../../src/door/transport.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

const OPTS = { vm: "myvm", vmSocket: "/vm/daemon.sock", hostSocket: "/tmp/daemon-host.sock" };

/** A run recorder that answers show-ssh + ssh by default; overridable per-cmd. */
function recorder(
  answer: (cmd: string, args: string[]) => RunResult | undefined = () => undefined,
) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    const a = answer(cmd, args);
    if (a) return a;
    if (cmd === "limactl") return ok("Host lima-myvm\n  Port 50348\n");
    return ok();
  };
  return { calls, run };
}

const fakeTransport: FramedTransport = async () => ({ status: "ok" });

describe("openLimaChannel", () => {
  test("captures lima ssh config, forwards the socket, and hands back a transport", async () => {
    const { calls, run } = recorder();
    let probes = 0;
    const deps: LimaChannelDeps = {
      run,
      exists: () => probes++ > 0, // stale-check false; ready on first poll
      sleep: async () => {},
      makeTransport: () => fakeTransport,
    };
    const ch = await openLimaChannel(OPTS, deps);

    expect(calls[0]).toEqual({ cmd: "limactl", args: ["show-ssh", "--format", "config", "myvm"] });
    const fwd = calls.find((c) => c.cmd === "ssh" && c.args.includes("-L"))!;
    expect(fwd.args).toContain("-f");
    expect(fwd.args).toContain("-N");
    expect(fwd.args).toContain("/tmp/daemon-host.sock:/vm/daemon.sock");
    expect(fwd.args).toContain("lima-myvm");
    expect(ch.hostSocket).toBe("/tmp/daemon-host.sock");
    expect(ch.transport).toBe(fakeTransport);

    await ch.close();
    const exit = calls.find(
      (c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit"),
    );
    expect(exit).toBeDefined();
    // close() is idempotent — a second call issues no further exit.
    const before = calls.length;
    await ch.close();
    expect(calls.length).toBe(before);
  });

  test("throws if limactl show-ssh fails", async () => {
    const { run } = recorder((cmd) => (cmd === "limactl" ? fail("no such instance") : undefined));
    await expect(
      openLimaChannel(OPTS, { run, exists: () => true, sleep: async () => {} }),
    ).rejects.toThrow(/show-ssh.*failed/);
  });

  test("throws if the forward fails — and best-effort tears the master down", async () => {
    const { calls, run } = recorder((cmd, args) =>
      cmd === "ssh" && args.includes("-L") ? fail("channel setup failed") : undefined,
    );
    await expect(
      openLimaChannel(OPTS, { run, exists: () => false, sleep: async () => {} }),
    ).rejects.toThrow(/forward failed/);
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit")),
    ).toBe(true);
  });

  test("throws if the forwarded socket never appears", async () => {
    const { run } = recorder();
    await expect(
      openLimaChannel(
        { ...OPTS, readyTimeoutMs: 100 },
        { run, exists: () => false, sleep: async () => {} },
      ),
    ).rejects.toThrow(/did not appear/);
  });
});

describe("withLimaChannel", () => {
  test("runs fn with the transport over the channel, then closes the forward", async () => {
    const { calls, run } = recorder();
    const deps: LimaChannelDeps = {
      run,
      exists: () => true,
      sleep: async () => {},
      makeTransport: () => fakeTransport,
    };
    let seen: FramedTransport | undefined;
    const result = await withLimaChannel(
      OPTS,
      async (transport) => {
        seen = transport;
        return "done";
      },
      deps,
    );
    expect(result).toBe("done");
    expect(seen).toBe(fakeTransport);
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit")),
    ).toBe(true);
  });

  test("closes the forward even when fn throws", async () => {
    const { calls, run } = recorder();
    const deps: LimaChannelDeps = {
      run,
      exists: () => true,
      sleep: async () => {},
      makeTransport: () => fakeTransport,
    };
    await expect(
      withLimaChannel(
        OPTS,
        async () => {
          throw new Error("boom");
        },
        deps,
      ),
    ).rejects.toThrow("boom");
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.includes("-O") && c.args.includes("exit")),
    ).toBe(true);
  });
});
