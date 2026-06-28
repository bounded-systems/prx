import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../door/lima-exec.ts";
import {
  deployGhappdBinary,
  provisionGhappd,
  startGhappd,
  stopGhappd,
  type GhappdLifecycleDeps,
} from "../lima-ghappd.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

function recorder(answer: (cmd: string, args: string[]) => RunResult | undefined = () => undefined) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return answer(cmd, args) ?? ok();
  };
  return { calls, run };
}

const script = (args: string[]): string => args[args.length - 1] ?? "";
const noSleep = async (): Promise<void> => {};

describe("deployGhappdBinary", () => {
  test("copies the binary in and makes it executable", () => {
    const { calls, run } = recorder();
    const vmBin = deployGhappdBinary({ vm: "myvm", binaryPath: "dist/prx-linux-arm64" }, { run });
    expect(vmBin).toBe("/tmp/prx");
    expect(calls[0]).toEqual({
      cmd: "limactl",
      args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"],
    });
  });
});

describe("startGhappd", () => {
  test("launches `ghapp serve` detached on the ghappd socket (cwd defaulted, ignored)", async () => {
    const { calls, run } = recorder();
    const deps: GhappdLifecycleDeps = { run, sleep: noSleep };
    const handle = await startGhappd({ vm: "myvm" }, deps);

    expect(handle.socket).toBe("/tmp/ghappd.sock");
    const launch = script(calls.find((c) => script(c.args).includes("ghapp serve"))!.args);
    expect(launch).toContain(
      "setsid nohup /tmp/prx ghapp serve --socket /tmp/ghappd.sock --cwd /tmp --pidfile /tmp/ghappd.pid",
    );
  });

  test("injects the App credential (id + installation as env; PEM from its file, out of argv)", async () => {
    const { calls, run } = recorder();
    await startGhappd(
      {
        vm: "myvm",
        appId: "Iv1",
        appKeyFile: "/run/secrets/ghapp.pem",
        installationId: "138039680",
      },
      { run, sleep: noSleep },
    );
    const launch = script(calls.find((c) => script(c.args).includes("ghapp serve"))!.args);
    expect(launch).toContain('PRX_GH_APP_ID="Iv1"');
    expect(launch).toContain('PRX_GH_APP_PRIVATE_KEY="$(cat /run/secrets/ghapp.pem)"');
    expect(launch).toContain('PRX_GH_INSTALLATION_ID="138039680"');
    expect(launch).toMatch(/PRX_GH_APP_PRIVATE_KEY="\$\(cat .*\)".*setsid nohup/);
  });

  test("no App credential env in the launch when unconfigured", async () => {
    const { calls, run } = recorder();
    await startGhappd({ vm: "myvm" }, { run, sleep: noSleep });
    const launch = script(calls.find((c) => script(c.args).includes("ghapp serve"))!.args);
    expect(launch).not.toContain("PRX_GH_APP");
  });
});

describe("stopGhappd", () => {
  test("removes the socket/log/pidfile by the daemon's own pidfile", async () => {
    const { calls, run } = recorder();
    await stopGhappd({ vm: "myvm" }, { run });
    const s = script(calls[0]!.args);
    expect(s).toContain("cat /tmp/ghappd.pid");
    expect(s).toContain("rm -f /tmp/ghappd.sock /tmp/ghappd.log /tmp/ghappd.pid");
  });
});

describe("provisionGhappd", () => {
  test("deploys then starts, returning a running handle", async () => {
    const { calls, run } = recorder();
    const handle = await provisionGhappd(
      { vm: "myvm", binaryPath: "dist/prx-linux-arm64" },
      { run, sleep: noSleep },
    );
    expect(handle.socket).toBe("/tmp/ghappd.sock");
    expect(calls[0]).toEqual({
      cmd: "limactl",
      args: ["copy", "dist/prx-linux-arm64", "myvm:/tmp/prx"],
    });
    expect(calls.some((c) => script(c.args).includes("ghapp serve"))).toBe(true);
  });
});
