// The prx-side beadsd door dialer: maps bd reads to `prx beads <verb>` over the
// door, and returns null (→ execBd fails closed) for anything off the read
// surface. The CommandRunner is injected so no real `prx`/daemon is spawned.

import { describe, expect, test } from "bun:test";

import type { CommandResult, CommandRunner } from "@bounded-systems/proc";

import { makePrxBeadsDoorDialer } from "../../src/beadsd/bd-door-dialer.ts";

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", status: 0 });

function recordingRunner(result: CommandResult): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd) => {
    calls.push(cmd);
    return result;
  };
  return { run, calls };
}

const env = { PRX_BEADS_DOOR: "host.sock" };

describe("prxBeadsDoorDialer", () => {
  test("list → `prx beads list` over the door, forwarding args verbatim", () => {
    const { run, calls } = recordingRunner(ok("[]"));
    const dialer = makePrxBeadsDoorDialer({ run });
    const r = dialer(
      { subcommand: "list", args: ["--limit", "20", "--status", "open", "--json"] },
      env,
    );
    expect(calls[0]).toEqual(["prx", "beads", "list", "--limit", "20", "--status", "open", "--json"]);
    expect(r).toEqual({ exitCode: 0, stdout: "[]", stderr: "", policy: null });
  });

  test("ready and show map onto the matching `prx beads` verbs", () => {
    const { run, calls } = recordingRunner(ok("out"));
    const dialer = makePrxBeadsDoorDialer({ run });
    dialer({ subcommand: "ready", args: ["--json"] }, env);
    dialer({ subcommand: "show", args: ["prx-1", "--json"] }, env);
    expect(calls[0]).toEqual(["prx", "beads", "ready", "--json"]);
    expect(calls[1]).toEqual(["prx", "beads", "show", "prx-1", "--json"]);
  });

  test("children → `prx beads children <id>` over the door (prx-zbsi)", () => {
    const { run, calls } = recordingRunner(ok("[]"));
    const dialer = makePrxBeadsDoorDialer({ run });
    const r = dialer({ subcommand: "children", args: ["prx-epic", "--json"] }, env);
    expect(calls[0]).toEqual(["prx", "beads", "children", "prx-epic", "--json"]);
    expect(r).toEqual({ exitCode: 0, stdout: "[]", stderr: "", policy: null });
  });

  test("memory reads recall/memories map onto the matching `prx beads` verbs (prx-44y)", () => {
    const { run, calls } = recordingRunner(ok("[]"));
    const dialer = makePrxBeadsDoorDialer({ run });
    dialer({ subcommand: "recall", args: ["handoff/a", "--json"] }, env);
    dialer({ subcommand: "memories", args: ["handoff/", "--json"] }, env);
    expect(calls[0]).toEqual(["prx", "beads", "recall", "handoff/a", "--json"]);
    expect(calls[1]).toEqual(["prx", "beads", "memories", "handoff/", "--json"]);
  });

  test("`dep list <id> --type parent-child` (a read) → `prx beads children <id>` (prx-zbsi)", () => {
    const { run, calls } = recordingRunner(ok("[]"));
    const dialer = makePrxBeadsDoorDialer({ run });
    const r = dialer(
      { subcommand: "dep", args: ["list", "prx-epic", "--direction", "up", "--type", "parent-child", "--json"] },
      env,
    );
    expect(calls[0]).toEqual(["prx", "beads", "children", "prx-epic", "--json"]);
    expect(r).toEqual({ exitCode: 0, stdout: "[]", stderr: "", policy: null });
  });

  test("`dep add`/`dep remove` (writes) still fail closed — only the parent-child list maps", () => {
    let spawned = false;
    const run: CommandRunner = () => {
      spawned = true;
      return ok("");
    };
    const dialer = makePrxBeadsDoorDialer({ run });
    expect(dialer({ subcommand: "dep", args: ["add", "--type", "parent-child", "a", "b"] }, env)).toBeNull();
    expect(dialer({ subcommand: "dep", args: ["remove", "a", "b"] }, env)).toBeNull();
    // A `dep list` without the parent-child type is not a children read either.
    expect(dialer({ subcommand: "dep", args: ["list", "prx-epic", "--json"] }, env)).toBeNull();
    expect(spawned).toBe(false);
  });

  test("honors a custom prx binary", () => {
    const { run, calls } = recordingRunner(ok("[]"));
    const dialer = makePrxBeadsDoorDialer({ run, prxBinary: "/opt/prx" });
    dialer({ subcommand: "list", args: [] }, env);
    expect(calls[0]?.[0]).toBe("/opt/prx");
  });

  test("passes a non-zero exit (and stderr) through to the caller", () => {
    const { run } = recordingRunner({ stdout: "", stderr: "door down", status: 7 });
    const dialer = makePrxBeadsDoorDialer({ run });
    const r = dialer({ subcommand: "list", args: [] }, env);
    expect(r).toEqual({ exitCode: 7, stdout: "", stderr: "door down", policy: null });
  });

  test.each(["remember", "create", "update", "close", "dep", "sql", "admin"])(
    "returns null for %s (off the door read surface → caller fails closed)",
    (subcommand) => {
      let spawned = false;
      const run: CommandRunner = () => {
        spawned = true;
        return ok("");
      };
      const dialer = makePrxBeadsDoorDialer({ run });
      expect(dialer({ subcommand, args: [] }, env)).toBeNull();
      // Crucially: an unsupported op must not spawn anything at all.
      expect(spawned).toBe(false);
    },
  );
});
