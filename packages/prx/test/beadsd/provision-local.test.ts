import { describe, expect, test } from "bun:test";

import type { RunResult } from "../../src/door/exec.ts";
import { provisionLocalBeads } from "../../src/beadsd/provision-local.ts";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });
const script = (args: string[]) => args[args.length - 1] ?? "";

/** Records bash invocations; answers the project_id query with a fixed id. */
function recorder() {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    if (script(args).includes("_project_id")) return ok("value\nproj-1234\n");
    return ok();
  };
  return { calls, run };
}

describe("provisionLocalBeads", () => {
  test("clones the reverse-DNS db locally and writes server-mode metadata", () => {
    const { calls, run } = recorder();
    const res = provisionLocalBeads(
      { originSlug: "bounded-systems/prx", cwd: "/home/u/.local/state/prx/beads" },
      { run },
    );

    expect(res.database).toBe("io_github_bounded_systems_prx");
    expect(res.remote).toBe("https://doltremoteapi.dolthub.com/bounded-systems/prx");
    expect(res.workspace).toBe("/home/u/.local/state/prx/beads");

    const scripts = calls.map((c) => script(c.args));
    // every effect is a local `bash -lc <script>` (login shell ⇒ nix PATH) — no limactl, no install.
    expect(calls.every((c) => c.cmd === "bash" && c.args[0] === "-lc")).toBe(true);
    expect(scripts.some((s) => s.includes("install -m0755"))).toBe(false);

    // requires bd+dolt on PATH
    expect(scripts[0]).toContain("command -v bd");
    expect(scripts[0]).toContain("command -v dolt");

    // clones into the reverse-DNS dir under the canonical cwd
    const clone = scripts.find((s) => s.includes("dolt clone"))!;
    expect(clone).toContain(
      "dolt clone https://doltremoteapi.dolthub.com/bounded-systems/prx /home/u/.local/state/prx/beads/.beads/dolt/io_github_bounded_systems_prx",
    );

    // writes full server-mode metadata.json carrying the read-back project_id
    const meta = scripts.find((s) => s.includes("metadata.json"))!;
    expect(meta).toContain('"dolt_mode":"server"');
    expect(meta).toContain('"dolt_database":"io_github_bounded_systems_prx"');
    expect(meta).toContain('"project_id":"proj-1234"');

    // brings the cloned schema current
    expect(scripts.some((s) => s.includes("bd migrate"))).toBe(true);

    // locks the .beads dir to 0700 (bd recommends it; avoids the perms warning)
    expect(scripts.some((s) => s.includes("chmod 700 /home/u/.local/state/prx/beads/.beads"))).toBe(
      true,
    );
  });

  test("throws when bd/dolt are not on PATH", () => {
    const run = (_cmd: string, args: string[]): RunResult =>
      script(args).includes("command -v bd") ? fail("not found") : ok();
    expect(() =>
      provisionLocalBeads({ originSlug: "bounded-systems/prx", cwd: "/ws" }, { run }),
    ).toThrow(/bd and dolt must be installed/);
  });

  test("rejects an unsafe origin slug (reverse-DNS guard)", () => {
    const { run } = recorder();
    expect(() => provisionLocalBeads({ originSlug: "../evil", cwd: "/ws" }, { run })).toThrow();
  });
});
