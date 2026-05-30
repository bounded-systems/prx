import { describe, expect, test } from "bun:test";

import { runRepairAssignees } from "../../src/delegate/repair_assignees.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

type Recorder = {
  calls: BdExecOptions[];
  exec: (opts: BdExecOptions) => BdExecResult;
};

function makeExec(
  results: Array<Partial<BdExecResult>> | ((opts: BdExecOptions) => Partial<BdExecResult>),
): Recorder {
  const calls: BdExecOptions[] = [];
  let i = 0;
  const exec = (opts: BdExecOptions): BdExecResult => {
    calls.push(opts);
    const r =
      typeof results === "function"
        ? results(opts)
        : (results[i++] ?? {});
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      policy: null,
      ...r,
    };
  };
  return { calls, exec };
}

const FROM_NAME = "Bounded Systems";
const TO_LOGIN = "bdelanghe";

function listStdout(
  rows: Array<{ id: string; title?: string; assignee?: string | null }>,
): string {
  return JSON.stringify(rows);
}

describe("runRepairAssignees — input validation", () => {
  test("empty --from → exit 2", () => {
    const rec = makeExec([]);
    const result = runRepairAssignees(
      { from: "", to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--from/);
    expect(rec.calls).toEqual([]);
  });

  test("empty --to → exit 2", () => {
    const rec = makeExec([]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: "  ", apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--to/);
    expect(rec.calls).toEqual([]);
  });
});

describe("runRepairAssignees — dry-run", () => {
  test("lists matched records and suggested bd assign lines", () => {
    const rec = makeExec([
      {
        exitCode: 0,
        stdout: listStdout([
          { id: "GH-2009", title: "sync flow", assignee: FROM_NAME },
          { id: "GH-2010", title: "another", assignee: FROM_NAME },
        ]),
      },
    ]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/2 record\(s\) would be rewritten/);
    expect(result.message).toMatch(/GH-2009/);
    expect(result.message).toMatch(/GH-2010/);
    expect(result.message).toMatch(/bd assign GH-2009 bdelanghe/);
    expect(result.message).toMatch(/Run with --apply/);
    // only the list call, no writes
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0]?.subcommand).toBe("list");
  });

  test("zero matches → exit 0 with empty-list message", () => {
    const rec = makeExec([{ exitCode: 0, stdout: "[]" }]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/0 record\(s\) matched/);
  });
});

describe("runRepairAssignees — apply", () => {
  test("invokes bd assign per match with login target", () => {
    const rec = makeExec((opts) => {
      if (opts.subcommand === "list") {
        return {
          exitCode: 0,
          stdout: listStdout([
            { id: "GH-2009", title: "x", assignee: FROM_NAME },
            { id: "GH-2010", title: "y", assignee: FROM_NAME },
          ]),
        };
      }
      return { exitCode: 0 };
    });
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: true, repoPath: "/repo" },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/rewrote 2 record/);
    const assigns = rec.calls.filter((c) => c.subcommand === "assign");
    expect(assigns).toEqual([
      {
        subcommand: "assign",
        args: ["GH-2009", TO_LOGIN],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
      {
        subcommand: "assign",
        args: ["GH-2010", TO_LOGIN],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
    ]);
  });

  test("partial failure → exit 1 with failing id list", () => {
    const rec = makeExec((opts) => {
      if (opts.subcommand === "list") {
        return {
          exitCode: 0,
          stdout: listStdout([
            { id: "GH-2009", title: "x", assignee: FROM_NAME },
            { id: "GH-2010", title: "y", assignee: FROM_NAME },
          ]),
        };
      }
      if (opts.args[0] === "GH-2010") {
        return { exitCode: 1, stderr: "bd error" };
      }
      return { exitCode: 0 };
    });
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: true, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/1\/2/);
    expect(result.message).toMatch(/GH-2010/);
  });
});

describe("runRepairAssignees — defensive equality filter", () => {
  test("rows whose assignee does not exactly equal --from are skipped", () => {
    // Future bd build might broaden `--assignee` to substring match — handler
    // still enforces exact equality.
    const rec = makeExec([
      {
        exitCode: 0,
        stdout: listStdout([
          { id: "GH-1", title: "match", assignee: FROM_NAME },
          { id: "GH-2", title: "substring", assignee: "Robert" },
          { id: "GH-3", title: "different", assignee: "alice" },
        ]),
      },
    ]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/1 record\(s\) would be rewritten/);
    expect(result.message).toMatch(/GH-1/);
    expect(result.message).not.toMatch(/GH-2/);
    expect(result.message).not.toMatch(/GH-3/);
  });
});

describe("runRepairAssignees — bd list failure", () => {
  test("non-zero list exit → exit 1 with detail", () => {
    const rec = makeExec([
      { exitCode: 2, stderr: "bd: cannot read db" },
    ]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/cannot read db/);
  });

  test("invalid JSON → exit 1", () => {
    const rec = makeExec([{ exitCode: 0, stdout: "not json" }]);
    const result = runRepairAssignees(
      { from: FROM_NAME, to: TO_LOGIN, apply: false, repoPath: "." },
      { execBd: rec.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/invalid JSON/);
  });
});
