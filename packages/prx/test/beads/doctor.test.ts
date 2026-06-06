import { describe, expect, test } from "bun:test";

import type { CommandResult, CommandRunner } from "@bounded-systems/proc";
import { diagnoseBeads, healBeads, type BeadsDoctorDeps } from "../../src/beads/doctor.ts";

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", status: 0 });

interface FakeOpts {
  /** issue_prefix before any bootstrap: a value, or null → "(not set)". */
  prefixInitial: string | null;
  /** issue_prefix after a bootstrap runs (default "prx"). */
  prefixAfterBootstrap?: string | null;
  database?: string | null;
}

/** A fake bd runner: `bd bootstrap` flips issue_prefix from initial → after. */
function fakeRunner(opts: FakeOpts) {
  let bootstrapped = false;
  const calls: string[][] = [];
  const run: CommandRunner = (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "bootstrap") {
      bootstrapped = true;
      return ok("Synced database from remote");
    }
    if (cmd[1] === "dolt" && cmd[2] === "stop") return ok("stopped");
    if (cmd[1] === "config" && cmd[2] === "get") {
      const key = cmd[3];
      if (key === "issue_prefix") {
        const after = "prefixAfterBootstrap" in opts ? opts.prefixAfterBootstrap! : "prx";
        const value = bootstrapped ? after : opts.prefixInitial;
        return ok(value ?? "issue_prefix (not set)");
      }
      if (key === "dolt_database") {
        const db = opts.database === undefined ? "io_github_bounded_systems_prx" : opts.database;
        return ok(db ?? "dolt_database (not set)");
      }
    }
    return ok();
  };
  return { run, calls };
}

describe("diagnoseBeads", () => {
  test("healthy when issue_prefix resolves", () => {
    const { run } = fakeRunner({ prefixInitial: "prx" });
    const d = diagnoseBeads({ run });
    expect(d.healthy).toBe(true);
    expect(d.prefix).toBe("prx");
    expect(d.database).toBe("io_github_bounded_systems_prx");
  });

  test("unhealthy when issue_prefix is (not set)", () => {
    const { run } = fakeRunner({ prefixInitial: null });
    const d = diagnoseBeads({ run });
    expect(d.healthy).toBe(false);
    expect(d.prefix).toBeNull();
  });
});

describe("healBeads", () => {
  test("no-op on a healthy workspace (no bootstrap)", () => {
    const { run, calls } = fakeRunner({ prefixInitial: "prx" });
    const res = healBeads({ run });
    expect(res.repaired).toBe(false);
    expect(res.action).toBe("none");
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(false);
  });

  test("re-bootstraps an unhealthy workspace: stop server, clear cache, bootstrap, re-probe", () => {
    const { run, calls } = fakeRunner({ prefixInitial: null, prefixAfterBootstrap: "prx" });
    const removed: string[] = [];
    const deps: BeadsDoctorDeps = {
      run,
      cwd: "/wt",
      exists: () => true,
      rmrf: (p) => removed.push(p),
    };
    const res = healBeads(deps);

    expect(res.repaired).toBe(true);
    expect(res.action).toBe("re-bootstrapped");
    expect(res.before.healthy).toBe(false);
    expect(res.after.healthy).toBe(true);
    // stopped the server, cleared the stale dolt cache, then bootstrapped — in order.
    expect(calls.some((c) => c[1] === "dolt" && c[2] === "stop")).toBe(true);
    expect(removed).toEqual(["/wt/.beads/dolt/io_github_bounded_systems_prx"]);
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(true);
  });

  test("skips the cache clear when the dolt dir does not exist", () => {
    const { run } = fakeRunner({ prefixInitial: null, prefixAfterBootstrap: "prx" });
    const removed: string[] = [];
    healBeads({ run, cwd: "/wt", exists: () => false, rmrf: (p) => removed.push(p) });
    expect(removed).toEqual([]);
  });

  test("reports not-repaired when bootstrap fails to stamp a prefix", () => {
    const { run } = fakeRunner({ prefixInitial: null, prefixAfterBootstrap: null });
    const res = healBeads({ run, exists: () => false });
    expect(res.repaired).toBe(false);
    expect(res.after.healthy).toBe(false);
  });
});
