import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/door/lima-exec.ts";
import {
  limaSshHostAlias,
  nixBuilderMachineLine,
  provisionVmNixBuilder,
  type NixBuilderMachine,
} from "../../src/lima/nix-builder.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const script = (args: string[]) => args[args.length - 1] ?? "";

/** Records limactl invocations; every effect returns ok. */
function recorder() {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return ok();
  };
  return { calls, run };
}

describe("limaSshHostAlias", () => {
  test("prefixes the vm with lima-", () => {
    expect(limaSshHostAlias("prx")).toBe("lima-prx");
  });
});

describe("nixBuilderMachineLine", () => {
  test("renders the 8 machines-file fields with - placeholders", () => {
    const m: NixBuilderMachine = {
      uri: "ssh-ng://lima-prx",
      systems: "aarch64-linux",
      maxJobs: 4,
      speedFactor: 1,
      supportedFeatures: ["big-parallel"],
    };
    expect(nixBuilderMachineLine(m)).toBe(
      "ssh-ng://lima-prx aarch64-linux - 4 1 big-parallel - -",
    );
  });

  test("collapses empty features to a single -", () => {
    const m: NixBuilderMachine = {
      uri: "ssh-ng://lima-x",
      systems: "aarch64-linux",
      maxJobs: 2,
      speedFactor: 1,
      supportedFeatures: [],
    };
    expect(nixBuilderMachineLine(m)).toBe("ssh-ng://lima-x aarch64-linux - 2 1 - - -");
  });
});

describe("provisionVmNixBuilder", () => {
  test("installs nix, registers the trusted-user, returns the machines line", () => {
    const { calls, run } = recorder();
    const res = provisionVmNixBuilder({ vm: "prx" }, { run });

    // every effect is a `limactl shell <vm> -- bash -lc <script>`
    expect(
      calls.every((c) => c.cmd === "limactl" && c.args.includes("prx") && c.args.includes("bash")),
    ).toBe(true);

    const scripts = calls.map((c) => script(c.args));

    // 1. skip-if-present nix install via the Determinate installer
    const install = scripts.find((s) => s.includes("install linux --no-confirm"))!;
    expect(install).toContain("command -v nix");
    expect(install).toContain("https://install.determinate.systems/nix");

    // 2. trusted-user + flakes, append-if-absent, daemon restart
    const trust = scripts.find((s) => s.includes("extra-trusted-users"))!;
    expect(trust).toContain('u="$(id -un)"');
    expect(trust).toContain("extra-experimental-features = nix-command flakes");
    expect(trust).toContain("systemctl restart nix-daemon");

    // descriptor + host registration line
    expect(res.machine.uri).toBe("ssh-ng://lima-prx");
    expect(res.machine.systems).toBe("aarch64-linux");
    expect(res.machinesLine).toBe("ssh-ng://lima-prx aarch64-linux - 4 1 big-parallel - -");
  });

  test("honors custom installer, systems, jobs, speed, features", () => {
    const { calls, run } = recorder();
    const res = provisionVmNixBuilder(
      {
        vm: "vm2",
        nixInstallerUrl: "https://nixos.org/nix/install",
        systems: "aarch64-linux,armv7l-linux",
        maxJobs: 8,
        speedFactor: 3,
        supportedFeatures: ["big-parallel", "kvm"],
      },
      { run },
    );
    expect(calls.map((c) => script(c.args)).find((s) => s.includes("command -v nix"))!).toContain(
      "https://nixos.org/nix/install",
    );
    expect(res.machinesLine).toBe(
      "ssh-ng://lima-vm2 aarch64-linux,armv7l-linux - 8 3 big-parallel,kvm - -",
    );
  });

  test("throws if the nix install fails", () => {
    const run = (_cmd: string, args: string[]): RunResult =>
      script(args).includes("install linux --no-confirm")
        ? { status: 1, stdout: "", stderr: "no network" }
        : ok();
    expect(() => provisionVmNixBuilder({ vm: "prx" }, { run })).toThrow(/install nix.*failed/);
  });

  test("throws if the trusted-user registration fails", () => {
    const run = (_cmd: string, args: string[]): RunResult =>
      script(args).includes("extra-trusted-users")
        ? { status: 2, stdout: "", stderr: "no sudo" }
        : ok();
    expect(() => provisionVmNixBuilder({ vm: "prx" }, { run })).toThrow(
      /register trusted-user.*failed/,
    );
  });
});
