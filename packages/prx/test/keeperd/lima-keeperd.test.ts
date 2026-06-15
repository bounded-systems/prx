import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/door/lima-exec.ts";
import {
  deployKeeperdBinary,
  provisionKeeperd,
  startKeeperd,
  stopKeeperd,
  type KeeperdLifecycleDeps,
} from "../../src/keeperd/lima-keeperd.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

function recorder(answer: (cmd: string, args: string[]) => RunResult | undefined = () => undefined) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return answer(cmd, args) ?? ok();
  };
  return { calls, run };
}

const isTestS = (args: string[]) => args.includes("test") && args.includes("-S");
const script = (args: string[]) => args[args.length - 1] ?? "";
const noSleep = async () => {};

describe("deployKeeperdBinary", () => {
  test("copies the binary in and makes it executable", () => {
    const { calls, run } = recorder();
    const vmBin = deployKeeperdBinary({ vm: "myvm", binaryPath: "dist/prx-linux-arm64" }, { run });
    expect(vmBin).toBe("/tmp/prx");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"] });
    expect(calls[1]).toEqual({
      cmd: "limactl",
      args: ["shell", "--workdir", "/", "myvm", "--", "chmod", "+x", "/tmp/prx"],
    });
  });

  test("throws if the copy fails", () => {
    const { run } = recorder((_cmd, args) => (args[0] === "copy" ? fail("no space") : undefined));
    expect(() => deployKeeperdBinary({ vm: "myvm", binaryPath: "b" }, { run })).toThrow(/copy.*failed/);
  });
});

describe("startKeeperd", () => {
  test("launches keeperd detached, waits for the socket, returns a handle", async () => {
    const { calls, run } = recorder();
    const deps: KeeperdLifecycleDeps = { run, sleep: noSleep };
    const handle = await startKeeperd({ vm: "myvm", cwd: "/vm/clone" }, deps);

    expect(handle.socket).toBe("/tmp/keeperd.sock");
    const launch = calls.find((c) => script(c.args).includes("keeper serve"))!;
    expect(script(launch.args)).toContain(
      "setsid nohup /tmp/prx keeper serve --socket /tmp/keeperd.sock --cwd /vm/clone --pidfile /tmp/keeperd.pid",
    );
    expect(script(launch.args)).toContain("</dev/null");
    expect(script(launch.args)).not.toContain("pkill"); // robust: no self-matching pkill
    expect(calls.some((c) => isTestS(c.args))).toBe(true);

    await handle.stop();
    const stopCall = calls.find((c) => script(c.args).includes("rm -f /tmp/keeperd.sock"))!;
    expect(script(stopCall.args)).toContain("cat /tmp/keeperd.pid");
    expect(script(stopCall.args)).toContain("rm -f /tmp/keeperd.sock /tmp/keeperd.log /tmp/keeperd.pid");
    expect(script(stopCall.args)).not.toContain("pkill");
  });

  test("injects PRX_PROVENANCE_KEY from the in-VM key file when provenanceKeyFile set (GH-236)", async () => {
    const { calls, run } = recorder();
    await startKeeperd(
      { vm: "myvm", cwd: "/vm/clone", provenanceKeyFile: "/home/dev/.ssh/keeper_provenance" },
      { run, sleep: noSleep },
    );
    const launch = script(calls.find((c) => script(c.args).includes("keeper serve"))!.args);
    // Env assignment from the file (kept out of argv), before setsid nohup.
    expect(launch).toContain('PRX_PROVENANCE_KEY="$(cat /home/dev/.ssh/keeper_provenance)" setsid nohup');
  });

  test("no PRX_PROVENANCE_KEY in the launch when provenanceKeyFile absent (bare push)", async () => {
    const { calls, run } = recorder();
    await startKeeperd({ vm: "myvm", cwd: "/vm/clone" }, { run, sleep: noSleep });
    const launch = script(calls.find((c) => script(c.args).includes("keeper serve"))!.args);
    expect(launch).not.toContain("PRX_PROVENANCE_KEY");
  });

  test("treats a non-zero launch exit (ssh backgrounding) as OK once the socket appears", async () => {
    // `limactl shell` returns non-zero when backgrounding a daemon even on
    // success; the readiness poll (test -S), not the launch exit, is the signal.
    const { run } = recorder((_cmd, args) =>
      script(args).includes("keeper serve") ? fail("client_loop: send disconnect") : undefined,
    );
    const handle = await startKeeperd({ vm: "myvm", cwd: "/vm/clone" }, { run, sleep: noSleep });
    expect(handle.socket).toBe("/tmp/keeperd.sock");
  });

  test("throws with the daemon log if the socket never appears", async () => {
    const { run } = recorder((_cmd, args) => {
      if (isTestS(args)) return fail("");
      if (script(args).startsWith("cat ")) return ok("EADDRINUSE boom");
      return undefined;
    });
    await expect(
      startKeeperd({ vm: "myvm", cwd: "/vm/clone", readyTimeoutMs: 100 }, { run, sleep: noSleep }),
    ).rejects.toThrow(/did not appear.*EADDRINUSE boom/s);
  });
});

describe("stopKeeperd", () => {
  test("kills the daemon and removes socket + log", async () => {
    const { calls, run } = recorder();
    await stopKeeperd({ vm: "myvm" }, { run });
    const s = script(calls[0]!.args);
    expect(s).toContain("cat /tmp/keeperd.pid");
    expect(s).toContain('kill "$P"');
    expect(s).toContain("rm -f /tmp/keeperd.sock /tmp/keeperd.log /tmp/keeperd.pid");
    expect(s).not.toContain("pkill");
  });
});

describe("provisionKeeperd", () => {
  test("deploys then starts, returning a running handle", async () => {
    const { calls, run } = recorder();
    const handle = await provisionKeeperd(
      { vm: "myvm", binaryPath: "dist/prx-linux-arm64", cwd: "/vm/clone" },
      { run, sleep: noSleep },
    );
    expect(handle.socket).toBe("/tmp/keeperd.sock");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"] });
    expect(calls.some((c) => script(c.args).includes("keeper serve"))).toBe(true);
  });
});
