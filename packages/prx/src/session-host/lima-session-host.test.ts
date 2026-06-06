import { describe, expect, test } from "bun:test";

import { type Run, type RunResult } from "../keeperd/lima-exec.ts";
import {
  deploySessionHostBinary,
  provisionSessionHost,
  startSessionHost,
  stopSessionHost,
} from "./lima-session-host.ts";

/** A fake Run that records calls; `test -S <socket>` becomes ready after N probes. */
function fakeRun(opts: { socketReadyAfter?: number } = {}): {
  run: Run;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let probes = 0;
  const ok: RunResult = { status: 0, stdout: "", stderr: "" };
  const run: Run = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes("test") && args.includes("-S")) {
      probes += 1;
      return { status: probes > (opts.socketReadyAfter ?? 0) ? 0 : 1, stdout: "", stderr: "" };
    }
    return ok;
  };
  return { run, calls };
}
const noSleep = async (): Promise<void> => {};

describe("lima session-host lifecycle (offline, fake Run)", () => {
  test("deploy copies the binary into the VM and chmods it", () => {
    const { run, calls } = fakeRun();
    const vmBin = deploySessionHostBinary({ vm: "vm0", binaryPath: "/host/prx" }, { run });
    expect(vmBin).toBe("/tmp/prx");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "/host/prx", "vm0:/tmp/prx"] });
    expect(calls[1]!.args.join(" ")).toContain("chmod +x /tmp/prx");
  });

  test("start launches `session-host serve` detached and waits for the socket", async () => {
    const { run, calls } = fakeRun({ socketReadyAfter: 0 }); // ready on first probe
    const handle = await startSessionHost(
      { vm: "vm0", socket: "/tmp/s.sock", stateDir: "/tmp/sd" },
      { run, sleep: noSleep },
    );
    expect(handle.socket).toBe("/tmp/s.sock");
    const launch = calls.find((c) => c.args.some((a) => a.includes("session-host serve")));
    expect(launch).toBeDefined();
    const script = launch!.args.join(" ");
    expect(script).toContain(
      "setsid nohup /tmp/prx session-host serve --socket /tmp/s.sock --state-dir /tmp/sd --pidfile",
    );
    expect(script).toContain("</dev/null >"); // detached, output to the log
  });

  test("start throws (with the daemon log) if the socket never appears", async () => {
    const { run } = fakeRun({ socketReadyAfter: 9999 }); // never ready
    await expect(
      startSessionHost({ vm: "vm0", readyTimeoutMs: 10 }, { run, sleep: noSleep }),
    ).rejects.toThrow(/did not appear/);
  });

  test("stop kills by pidfile (not pkill) and cleans up socket/log/pidfile", async () => {
    const { run, calls } = fakeRun();
    await stopSessionHost(
      { vm: "vm0", socket: "/tmp/s.sock", pidfile: "/tmp/s.pid", logPath: "/tmp/s.log" },
      { run },
    );
    const script = calls[0]!.args.join(" ");
    expect(script).toContain('cat /tmp/s.pid');
    expect(script).not.toContain("pkill");
    expect(script).toContain("rm -f /tmp/s.sock");
  });

  test("the start handle's stop() tears the daemon down", async () => {
    const { run, calls } = fakeRun({ socketReadyAfter: 0 });
    const handle = await startSessionHost({ vm: "vm0", pidfile: "/tmp/p.pid" }, { run, sleep: noSleep });
    await handle.stop();
    expect(calls.some((c) => c.args.join(" ").includes("cat /tmp/p.pid"))).toBe(true);
  });

  test("provision deploys then starts", async () => {
    const { run, calls } = fakeRun({ socketReadyAfter: 0 });
    const handle = await provisionSessionHost(
      { vm: "vm0", binaryPath: "/host/prx", socket: "/tmp/s.sock", stateDir: "/tmp/sd" },
      { run, sleep: noSleep },
    );
    expect(handle.socket).toBe("/tmp/s.sock");
    expect(calls[0]!.args[0]).toBe("copy"); // deployed first
    expect(calls.some((c) => c.args.some((a) => a.includes("session-host serve")))).toBe(true);
  });
});
