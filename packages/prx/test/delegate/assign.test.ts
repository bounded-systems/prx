import { describe, expect, test } from "bun:test";

import { runDelegateAssign } from "../../src/delegate/assign.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

// GH-296 / prx-82b: the assign write now runs `prx beads update <id> --assignee
// <name>` through the daemon (a sync runner), not host `bd assign`. The fake
// runner records the equivalent old `bd assign` BdExecOptions shape so the
// existing call assertions hold; `result` still drives failure injection.
type Recorder = {
  calls: BdExecOptions[];
  run: (cmd: string[], opts?: { cwd?: string; check?: boolean }) => {
    status: number;
    stdout: string;
    stderr: string;
  };
};

function recordingExec(result: Partial<BdExecResult> = {}): Recorder {
  const merged: BdExecResult = { exitCode: 0, stdout: "", stderr: "", policy: null, ...result };
  const calls: BdExecOptions[] = [];
  return {
    calls,
    run: (cmd: string[], opts?: { cwd?: string; check?: boolean }) => {
      // cmd = ["prx","beads","update", <id>, "--assignee", <target>]
      const id = cmd[3] ?? "";
      const target = cmd[5] ?? "";
      calls.push({
        subcommand: "assign",
        args: [id, target],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        state: "planning",
        role: "planner",
      } as BdExecOptions);
      return { status: merged.exitCode, stdout: merged.stdout, stderr: merged.stderr };
    },
  };
}

function showOk(id: string, status: string = "open") {
  return () => ({
    ok: true as const,
    record: {
      id,
      title: "",
      status,
      labels: [],
      blockedBy: [],
    },
    stdout: "",
    stderr: "",
  });
}

function showFail() {
  return () => ({
    ok: false as const,
    exitCode: 1,
    stdout: "",
    stderr: "issue not found",
  });
}

describe("runDelegateAssign — mode dispatch", () => {
  test("no mode → exit 2 usage", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/requires one of/);
    expect(rec.calls).toEqual([]);
  });

  test("multi-mode (--self + --unassign) → exit 2 usage", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", self: true, unassign: true, repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/exactly one/);
    expect(rec.calls).toEqual([]);
  });

  test("agent + --unassign → exit 2 usage", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", agent: "alice", unassign: true, repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(result.exitCode).toBe(2);
    expect(rec.calls).toEqual([]);
  });

  test("empty agent string → exit 2 usage", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", agent: "   ", repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(result.exitCode).toBe(2);
    expect(rec.calls).toEqual([]);
  });
});

describe("runDelegateAssign — eligibility", () => {
  test("bd show failure → exit 1 not eligible", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-999999", agent: "alice", repoPath: "." },
      { run: rec.run, runBdShow: showFail() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/not eligible/);
    expect(rec.calls).toEqual([]);
  });

  test("closed issue → exit 1 not eligible", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-7", agent: "alice", repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-7", "closed") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/closed/);
    expect(rec.calls).toEqual([]);
  });
});

describe("runDelegateAssign — agent passthrough", () => {
  test("happy path: assigns the named agent via bd assign", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-456", agent: "alice", repoPath: "/repo" },
      { run: rec.run, runBdShow: showOk("GH-456") },
    );
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated GH-456 → alice",
    });
    expect(rec.calls).toEqual([
      {
        subcommand: "assign",
        args: ["GH-456", "alice"],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
    ]);
  });

  test("agent name is trimmed", () => {
    const rec = recordingExec();
    runDelegateAssign(
      { id: "GH-1", agent: "  bob  ", repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(rec.calls[0]?.args).toEqual(["GH-1", "bob"]);
  });

  test("bd write failure propagates", () => {
    const rec = recordingExec({ exitCode: 1, stderr: "bd error" });
    const result = runDelegateAssign(
      { id: "GH-1", agent: "alice", repoPath: "." },
      { run: rec.run, runBdShow: showOk("GH-1") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/bd error/);
  });
});

describe("runDelegateAssign — --self resolver (GH-2012 login-shape)", () => {
  test("--self resolves to GH login and assigns", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", self: true, repoPath: "." },
      {
        run: rec.run,
        runBdShow: showOk("GH-1"),
        resolveSelfOperator: () => ({ ok: true, agent: "bdelanghe" }),
      },
    );
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated GH-1 → bdelanghe",
    });
    expect(rec.calls[0]?.args).toEqual(["GH-1", "bdelanghe"]);
  });

  test("--self resolver failure → exit 1 with resolver message", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-1", self: true, repoPath: "." },
      {
        run: rec.run,
        runBdShow: showOk("GH-1"),
        resolveSelfOperator: () => ({
          ok: false,
          message: "gh auth status failed — run `gh auth login`",
        }),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/gh auth status/);
    expect(rec.calls).toEqual([]);
  });
});

describe("runDelegateAssign — --unassign", () => {
  test("--unassign calls bd assign with empty string and reports cleared", () => {
    const rec = recordingExec();
    const result = runDelegateAssign(
      { id: "GH-9", unassign: true, repoPath: "/r" },
      { run: rec.run, runBdShow: showOk("GH-9") },
    );
    expect(result).toEqual({
      exitCode: 0,
      message: "unassigned GH-9",
    });
    expect(rec.calls).toEqual([
      {
        subcommand: "assign",
        args: ["GH-9", ""],
        cwd: "/r",
        state: "planning",
        role: "planner",
      },
    ]);
  });
});
