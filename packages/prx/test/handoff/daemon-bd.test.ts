// The handoff bd adapter: an execBd-shaped seam that routes a bd memory op
// through `prx beads <subcommand> <args>` (daemon → canonical store) instead of
// raw `bd`. The runner is injected so no real `prx`/daemon is spawned. (prx-44y)

import { describe, expect, test } from "bun:test";

import type { CommandResult, CommandRunner } from "@bounded-systems/proc";

import { makeHandoffDaemonBd } from "../../src/handoff/daemon-bd.ts";

describe("handoffDaemonBd (prx-44y)", () => {
  test("routes a memory read through `prx beads <subcommand> <args>` and shapes the result", () => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd) => {
      calls.push(cmd);
      return { stdout: "[]", stderr: "", status: 0 } satisfies CommandResult;
    };
    const bd = makeHandoffDaemonBd({ run });
    const r = bd({ subcommand: "memories", args: ["handoff/", "--json"], state: "planning", role: "planner" });
    expect(calls[0]).toEqual(["prx", "beads", "memories", "handoff/", "--json"]);
    expect(r).toEqual({ exitCode: 0, stdout: "[]", stderr: "", policy: null });
  });

  test("remember (write) forwards body + --key; a non-zero exit surfaces as exitCode", () => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd) => {
      calls.push(cmd);
      return { stdout: "", stderr: "boom", status: 1 };
    };
    const bd = makeHandoffDaemonBd({ run });
    const r = bd({
      subcommand: "remember",
      args: ['{"id":"h"}', "--key", "handoff/a", "--json"],
      state: "planning",
      role: "planner",
    });
    expect(calls[0]).toEqual(["prx", "beads", "remember", '{"id":"h"}', "--key", "handoff/a", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("boom");
  });

  test("threads cwd to the runner and honors a custom prx binary", () => {
    const calls: Array<{ cmd: string[]; cwd?: string | undefined }> = [];
    const run: CommandRunner = (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      return { stdout: "", stderr: "", status: 0 };
    };
    const bd = makeHandoffDaemonBd({ run, prxBinary: "/opt/prx" });
    bd({ subcommand: "recall", args: ["k", "--json"], cwd: "/clone", state: "planning", role: "planner" });
    expect(calls[0]!.cmd[0]).toBe("/opt/prx");
    expect(calls[0]!.cwd).toBe("/clone");
  });
});
