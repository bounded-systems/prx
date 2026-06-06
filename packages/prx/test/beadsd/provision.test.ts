import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/keeperd/lima-exec.ts";
import { doltHubUrl, provisionVmBeads } from "../../src/beadsd/provision.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const script = (args: string[]) => args[args.length - 1] ?? "";

/** Records limactl invocations; answers the project_id query with a fixed id. */
function recorder() {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    if (script(args).includes("_project_id")) return ok("value\nproj-1234\n");
    return ok();
  };
  return { calls, run };
}

describe("doltHubUrl", () => {
  test("maps owner/repo to the DoltHub remote", () => {
    expect(doltHubUrl("bounded-systems/prx")).toBe("https://doltremoteapi.dolthub.com/bounded-systems/prx");
  });
});

describe("provisionVmBeads", () => {
  test("installs bd+dolt, clones the reverse-DNS db, writes server-mode metadata", () => {
    const { calls, run } = recorder();
    const res = provisionVmBeads({ vm: "myvm", originSlug: "bounded-systems/prx" }, { run });

    expect(res.database).toBe("io_github_bounded_systems_prx");
    expect(res.remote).toBe("https://doltremoteapi.dolthub.com/bounded-systems/prx");
    expect(res.workspace).toBe("$HOME/prx-vm-beads");

    const scripts = calls.map((c) => script(c.args));
    // every effect is a `limactl shell <vm> -- bash -lc <script>`
    expect(calls.every((c) => c.cmd === "limactl" && c.args.includes("myvm") && c.args.includes("bash"))).toBe(true);

    // 1. install (skip-if-present) of both binaries to /usr/local/bin
    const install = scripts.find((s) => s.includes("install -m0755"))!;
    expect(install).toContain("gastownhall/beads/releases/download/v1.0.3/beads_1.0.3_linux_arm64.tar.gz");
    expect(install).toContain("dolthub/dolt/releases/download/v1.86.2/dolt-linux-arm64.tar.gz");
    expect(install).toContain("command -v bd");

    // 2. dolt clone canonical into the reverse-DNS db dir (NOT a bare bootstrap)
    const clone = scripts.find((s) => s.includes("dolt clone"))!;
    expect(clone).toContain(
      "dolt clone https://doltremoteapi.dolthub.com/bounded-systems/prx $HOME/prx-vm-beads/.beads/dolt/io_github_bounded_systems_prx",
    );
    expect(clone).toContain("git remote add origin https://github.com/bounded-systems/prx.git");
    expect(scripts.some((s) => s.includes("bd bootstrap"))).toBe(false);

    // 3. read project_id from the clone
    expect(scripts.some((s) => s.includes("_project_id"))).toBe(true);

    // 4. full server-mode metadata.json carrying the read project_id
    const meta = scripts.find((s) => s.includes("metadata.json"))!;
    expect(meta).toContain('"dolt_mode":"server"');
    expect(meta).toContain('"dolt_database":"io_github_bounded_systems_prx"');
    expect(meta).toContain('"project_id":"proj-1234"');

    // 5. schema migration so bd can read the older canonical clone
    expect(scripts.some((s) => s.includes("bd migrate"))).toBe(true);
  });

  test("honors a custom workspace + versions", () => {
    const { calls, run } = recorder();
    const res = provisionVmBeads(
      { vm: "vm2", originSlug: "acme/widgets", workspace: "/opt/beads", bdVersion: "1.0.4", doltVersion: "1.90.0" },
      { run },
    );
    expect(res.database).toBe("io_github_acme_widgets");
    expect(res.workspace).toBe("/opt/beads");
    const scripts = calls.map((c) => script(c.args));
    expect(scripts.find((s) => s.includes("install"))!).toContain("beads_1.0.4_linux_arm64.tar.gz");
    expect(scripts.find((s) => s.includes("dolt clone"))!).toContain("/opt/beads/.beads/dolt/io_github_acme_widgets");
  });

  test("throws if an install/clone step fails", () => {
    const run = (_cmd: string, args: string[]): RunResult =>
      script(args).includes("install -m0755") ? { status: 1, stdout: "", stderr: "no space" } : ok();
    expect(() => provisionVmBeads({ vm: "myvm", originSlug: "o/r" }, { run })).toThrow(/install bd\+dolt.*failed/);
  });
});
