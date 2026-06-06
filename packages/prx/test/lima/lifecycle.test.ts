import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/keeperd/lima-exec.ts";
import {
  deployDaemonBinary,
  provisionDaemon,
  startDaemon,
  stopDaemon,
  type DaemonLifecycleDeps,
  type DaemonSpec,
} from "../../src/lima/lifecycle.ts";

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

/** A sample daemon for the generic lifecycle (a two-word serve subcommand). */
const SPEC: DaemonSpec = { name: "demod", serveCommand: ["demo", "serve"] };

describe("deployDaemonBinary", () => {
  test("copies the binary in and makes it executable", () => {
    const { calls, run } = recorder();
    const vmBin = deployDaemonBinary({ vm: "myvm", binaryPath: "dist/prx-linux-arm64" }, { run });
    expect(vmBin).toBe("/tmp/prx");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"] });
    expect(calls[1]).toEqual({
      cmd: "limactl",
      args: ["shell", "--workdir", "/", "myvm", "--", "chmod", "+x", "/tmp/prx"],
    });
  });

  test("throws if the copy fails", () => {
    const { run } = recorder((_cmd, args) => (args[0] === "copy" ? fail("no space") : undefined));
    expect(() => deployDaemonBinary({ vm: "myvm", binaryPath: "b" }, { run })).toThrow(/copy.*failed/);
  });
});

describe("startDaemon", () => {
  test("launches the daemon's serve subcommand detached, defaults paths from the spec name", async () => {
    const { calls, run } = recorder();
    const deps: DaemonLifecycleDeps = { run, sleep: noSleep };
    const handle = await startDaemon(SPEC, { vm: "myvm", cwd: "/vm/clone" }, deps);

    expect(handle.socket).toBe("/tmp/demod.sock");
    const launch = calls.find((c) => script(c.args).includes("demo serve"))!;
    expect(script(launch.args)).toContain(
      "setsid nohup /tmp/prx demo serve --socket /tmp/demod.sock --cwd /vm/clone --pidfile /tmp/demod.pid",
    );
    expect(script(launch.args)).toContain("</dev/null");
    expect(script(launch.args)).not.toContain("pkill"); // robust: no self-matching pkill
    expect(calls.some((c) => isTestS(c.args))).toBe(true);

    await handle.stop();
    const stopCall = calls.find((c) => script(c.args).includes("rm -f /tmp/demod.sock"))!;
    expect(script(stopCall.args)).toContain("cat /tmp/demod.pid");
    expect(script(stopCall.args)).toContain("rm -f /tmp/demod.sock /tmp/demod.log /tmp/demod.pid");
  });

  test("injects the env-prefix verbatim before setsid nohup (kept out of argv)", async () => {
    const { calls, run } = recorder();
    await startDaemon(
      SPEC,
      { vm: "myvm", cwd: "/vm/clone", envPrefix: 'SECRET="$(cat /k)" ' },
      { run, sleep: noSleep },
    );
    const launch = script(calls.find((c) => script(c.args).includes("demo serve"))!.args);
    expect(launch).toContain('SECRET="$(cat /k)" setsid nohup');
  });

  test("no env-prefix in the launch when none given — setsid follows the cleanup directly", async () => {
    const { calls, run } = recorder();
    await startDaemon(SPEC, { vm: "myvm", cwd: "/vm/clone" }, { run, sleep: noSleep });
    const launch = script(calls.find((c) => script(c.args).includes("demo serve"))!.args);
    expect(launch).toContain("; setsid nohup /tmp/prx demo serve");
  });

  test("treats a non-zero launch exit (ssh backgrounding) as OK once the socket appears", async () => {
    const { run } = recorder((_cmd, args) =>
      script(args).includes("demo serve") ? fail("client_loop: send disconnect") : undefined,
    );
    const handle = await startDaemon(SPEC, { vm: "myvm", cwd: "/vm/clone" }, { run, sleep: noSleep });
    expect(handle.socket).toBe("/tmp/demod.sock");
  });

  test("throws with the daemon log if the socket never appears", async () => {
    const { run } = recorder((_cmd, args) => {
      if (isTestS(args)) return fail("");
      if (script(args).startsWith("cat ")) return ok("EADDRINUSE boom");
      return undefined;
    });
    await expect(
      startDaemon(SPEC, { vm: "myvm", cwd: "/vm/clone", readyTimeoutMs: 100 }, { run, sleep: noSleep }),
    ).rejects.toThrow(/demod socket.*did not appear.*EADDRINUSE boom/s);
  });
});

describe("stopDaemon", () => {
  test("kills by pidfile and removes socket + log (no pkill)", async () => {
    const { calls, run } = recorder();
    await stopDaemon(SPEC, { vm: "myvm" }, { run });
    const s = script(calls[0]!.args);
    expect(s).toContain("cat /tmp/demod.pid");
    expect(s).toContain('kill "$P"');
    expect(s).toContain("rm -f /tmp/demod.sock /tmp/demod.log /tmp/demod.pid");
    expect(s).not.toContain("pkill");
  });
});

describe("provisionDaemon", () => {
  test("deploys then starts, returning a running handle", async () => {
    const { calls, run } = recorder();
    const handle = await provisionDaemon(
      SPEC,
      { vm: "myvm", binaryPath: "dist/prx-linux-arm64", cwd: "/vm/clone" },
      { run, sleep: noSleep },
    );
    expect(handle.socket).toBe("/tmp/demod.sock");
    expect(calls[0]).toEqual({ cmd: "limactl", args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"] });
    expect(calls.some((c) => script(c.args).includes("demo serve"))).toBe(true);
  });
});
