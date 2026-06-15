import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/door/lima-exec.ts";
import type { DaemonLifecycleDeps } from "../../src/lima/lifecycle.ts";
import {
  LIMA_DAEMONS,
  LIMA_DAEMON_KEYS,
  limaDaemonStatuses,
  selectLimaDaemons,
} from "../../src/lima/registry.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const script = (args: string[]) => args[args.length - 1] ?? "";

function recorder(answer: (cmd: string, args: string[]) => RunResult | undefined = () => undefined) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return answer(cmd, args) ?? ok();
  };
  return { calls, run };
}

describe("LIMA_DAEMONS registry", () => {
  test("registers keeperd (signing) and beadsd (read-only) with their default sockets", () => {
    expect(LIMA_DAEMON_KEYS).toEqual(["keeper", "beads"]);
    const keeper = LIMA_DAEMONS.find((d) => d.key === "keeper")!;
    const beads = LIMA_DAEMONS.find((d) => d.key === "beads")!;
    expect(keeper).toMatchObject({ name: "keeperd", socket: "/tmp/keeperd.sock", signing: true });
    expect(beads).toMatchObject({ name: "beadsd", socket: "/tmp/beadsd.sock", signing: false });
  });
});

describe("selectLimaDaemons", () => {
  test("undefined / 'all' selects every daemon", () => {
    expect(selectLimaDaemons().map((d) => d.key)).toEqual(["keeper", "beads"]);
    expect(selectLimaDaemons("all").map((d) => d.key)).toEqual(["keeper", "beads"]);
  });

  test("a key selects just that daemon", () => {
    expect(selectLimaDaemons("beads").map((d) => d.key)).toEqual(["beads"]);
  });

  test("an unknown key throws", () => {
    expect(() => selectLimaDaemons("bogus")).toThrow(/unknown daemon 'bogus'/);
  });
});

describe("provision adapters launch the right daemon's serve subcommand", () => {
  test("keeper.provision launches `keeper serve`; beads.provision launches `beads serve`", async () => {
    const keeper = LIMA_DAEMONS.find((d) => d.key === "keeper")!;
    const beads = LIMA_DAEMONS.find((d) => d.key === "beads")!;

    const kCalls = recorder();
    const kDeps: DaemonLifecycleDeps = { run: kCalls.run, sleep: async () => {} };
    await keeper.provision({ vm: "myvm", binaryPath: "b", cwd: "/c" }, kDeps);
    expect(kCalls.calls.some((c) => script(c.args).includes("keeper serve"))).toBe(true);

    const bCalls = recorder();
    const bDeps: DaemonLifecycleDeps = { run: bCalls.run, sleep: async () => {} };
    await beads.provision({ vm: "myvm", binaryPath: "b", cwd: "/c" }, bDeps);
    const bLaunch = script(bCalls.calls.find((c) => script(c.args).includes("beads serve"))!.args);
    expect(bLaunch).toContain("beads serve");
    // beadsd is read-only — its launch carries no provenance key.
    expect(bLaunch).not.toContain("PRX_PROVENANCE_KEY");
  });
});

describe("limaDaemonStatuses", () => {
  test("probes each daemon's socket and reports up/down", () => {
    // keeperd socket present (test -S → 0), beadsd absent (→ 1).
    const { run } = recorder((_cmd, args) => {
      if (args.includes("test") && args.includes("-S")) {
        return args.includes("/tmp/keeperd.sock") ? ok() : { status: 1, stdout: "", stderr: "" };
      }
      return undefined;
    });
    const statuses = limaDaemonStatuses("myvm", selectLimaDaemons("all"), { run });
    expect(statuses.find((s) => s.key === "keeper")!.up).toBe(true);
    expect(statuses.find((s) => s.key === "beads")!.up).toBe(false);
  });
});
