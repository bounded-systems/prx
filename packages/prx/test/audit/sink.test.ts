import { describe, expect, test } from "bun:test";
import { createActor, setup } from "xstate";

import {
  appendAuditRow,
  auditSinkPath,
  makeAuditInspector,
  type AuditSinkDeps,
} from "../../src/audit/sink.ts";

const APPLY_ROW = {
  ts: "2026-05-04T12:00:00.000Z",
  issue: 42,
  url: "https://github.com/bdelanghe/ai-home/issues/42",
  action: "add-remove" as const,
  add: ["type::feature"],
  remove: [],
  prev: ["needs-triage"],
  proposed: ["type::feature"],
  actor: "claude-code" as const,
  dryRun: false,
  exitCode: 0,
};

function makeCapture() {
  const writes: Array<{ path: string; line: string }> = [];
  const ensured: string[] = [];
  const stdout: string[] = [];
  const deps: AuditSinkDeps = {
    appendFn: (path, line) => writes.push({ path, line }),
    ensureDir: (path) => ensured.push(path),
    stdoutFn: (line) => stdout.push(line),
    env: {} as NodeJS.ProcessEnv,
  };
  return { writes, ensured, stdout, deps };
}

describe("auditSinkPath", () => {
  test("renders YYYY-MM-DD bucket under prx/audit", () => {
    const path = auditSinkPath(new Date("2026-05-04T12:34:56.000Z"), {
      stateDirOverride: "/tmp/state",
    });
    expect(path).toBe("/tmp/state/prx/audit/2026-05-04.ndjson");
  });

  test("honors XDG_STATE_HOME via env override", () => {
    const path = auditSinkPath(new Date("2026-05-04T00:00:00.000Z"), {
      env: { XDG_STATE_HOME: "/var/xdg" } as NodeJS.ProcessEnv,
    });
    expect(path).toBe("/var/xdg/prx/audit/2026-05-04.ndjson");
  });

  test("falls back to ~/.local/state when XDG_STATE_HOME unset", () => {
    const path = auditSinkPath(new Date("2026-05-04T00:00:00.000Z"), {
      env: {} as NodeJS.ProcessEnv,
    });
    // The path ends with /.local/state/prx/audit/2026-05-04.ndjson — the
    // homedir prefix varies per environment, so anchor the assertion at the
    // tail of the path.
    expect(path.endsWith("/.local/state/prx/audit/2026-05-04.ndjson")).toBe(true);
  });

  test("date bucket rolls over on midnight UTC", () => {
    const before = auditSinkPath(new Date("2026-05-04T23:59:59.999Z"), {
      stateDirOverride: "/tmp/s",
    });
    const after = auditSinkPath(new Date("2026-05-05T00:00:00.000Z"), {
      stateDirOverride: "/tmp/s",
    });
    expect(before).toBe("/tmp/s/prx/audit/2026-05-04.ndjson");
    expect(after).toBe("/tmp/s/prx/audit/2026-05-05.ndjson");
  });
});

describe("appendAuditRow", () => {
  test("validates and appends one NDJSON line at the daily path", () => {
    const cap = makeCapture();
    appendAuditRow(APPLY_ROW, {
      ...cap.deps,
      stateDirOverride: "/tmp/state",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(cap.writes).toHaveLength(1);
    expect(cap.writes[0]!.path).toBe("/tmp/state/prx/audit/2026-05-04.ndjson");
    expect(cap.writes[0]!.line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(cap.writes[0]!.line.trimEnd());
    expect(parsed.issue).toBe(42);
    expect(cap.ensured).toEqual(["/tmp/state/prx/audit"]);
    expect(cap.stdout).toHaveLength(0);
  });

  test("rejects rows that do not match auditRowSchema", () => {
    const cap = makeCapture();
    expect(() =>
      appendAuditRow(
        { ts: "2026-05-04T12:00:00.000Z", action: "garbage" },
        { ...cap.deps, stateDirOverride: "/tmp/s" },
      ),
    ).toThrow();
    expect(cap.writes).toHaveLength(0);
  });

  test("mirrors to stdout when PRX_AUDIT_STDOUT=1", () => {
    const cap = makeCapture();
    appendAuditRow(APPLY_ROW, {
      ...cap.deps,
      stateDirOverride: "/tmp/s",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      env: { PRX_AUDIT_STDOUT: "1" } as NodeJS.ProcessEnv,
    });
    expect(cap.writes).toHaveLength(1);
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]!).toBe(cap.writes[0]!.line);
  });

  test("validates a machine-event row (entry)", () => {
    const cap = makeCapture();
    const row = {
      ts: "2026-05-04T12:00:00.000Z",
      machine: "triage" as const,
      kind: "entry" as const,
      state: "loadingStatus",
      actor: "claude-code",
    };
    appendAuditRow(row, {
      ...cap.deps,
      stateDirOverride: "/tmp/s",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(cap.writes).toHaveLength(1);
    const parsed = JSON.parse(cap.writes[0]!.line.trimEnd());
    expect(parsed.machine).toBe("triage");
    expect(parsed.kind).toBe("entry");
  });
});

describe("makeAuditInspector", () => {
  test("emits entry rows on root-actor state changes", () => {
    const cap = makeCapture();
    let clock = 0;
    const m = setup({
      types: {} as { events: { type: "GO" } | { type: "STOP" } },
    }).createMachine({
      id: "demo",
      initial: "a",
      states: {
        a: { on: { GO: "b" } },
        b: { on: { STOP: "c" } },
        c: { type: "final" },
      },
    });
    const inspector = makeAuditInspector("triage", {
      workUnitId: "GH-1403",
      deps: {
        ...cap.deps,
        stateDirOverride: "/tmp/s",
        now: () => new Date(clock),
      },
    });
    const actor = createActor(m, { inspect: inspector });
    actor.start();
    clock = 1_000;
    actor.send({ type: "GO" });
    clock = 3_000;
    actor.send({ type: "STOP" });

    const rows = cap.writes.map((w) => JSON.parse(w.line.trimEnd()));
    // Initial entry "a"
    expect(rows[0]).toMatchObject({
      machine: "triage",
      kind: "entry",
      state: "a",
      workUnitId: "GH-1403",
    });
    // a → b: exit "a" with durationMs, then entry "b" with prevState
    const exitA = rows.find((r) => r.kind === "exit" && r.state === "a");
    expect(exitA).toBeDefined();
    expect(exitA.durationMs).toBe(1_000);
    const entryB = rows.find((r) => r.kind === "entry" && r.state === "b");
    expect(entryB).toBeDefined();
    expect(entryB.prevState).toBe("a");
    expect(entryB.event).toBe("GO");
    // b → c
    const exitB = rows.find((r) => r.kind === "exit" && r.state === "b");
    expect(exitB).toBeDefined();
    expect(exitB.durationMs).toBe(2_000);
  });

  test("emits machine:pilot rows so pilot transitions are observable (GH-360)", () => {
    const cap = makeCapture();
    const m = setup({
      types: {} as { events: { type: "ADVANCE" } },
    }).createMachine({
      id: "pilot",
      initial: "planning",
      states: {
        planning: { on: { ADVANCE: "executing" } },
        executing: { type: "final" },
      },
    });
    const actor = createActor(m, {
      inspect: makeAuditInspector("pilot", {
        workUnitId: "GH-360",
        deps: { ...cap.deps, stateDirOverride: "/tmp/s" },
      }),
    });
    actor.start();
    actor.send({ type: "ADVANCE" });

    const rows = cap.writes.map((w) => JSON.parse(w.line.trimEnd()));
    expect(rows[0]).toMatchObject({
      machine: "pilot",
      kind: "entry",
      state: "planning",
      workUnitId: "GH-360",
    });
    expect(rows.find((r) => r.kind === "entry" && r.state === "executing")).toBeDefined();
  });

  test("does not emit when state value is unchanged", () => {
    const cap = makeCapture();
    const m = setup({
      types: {} as { events: { type: "PING" } },
    }).createMachine({
      id: "demo",
      initial: "a",
      states: {
        a: { on: { PING: { target: "a" } } },
      },
    });
    const inspector = makeAuditInspector("triage", {
      deps: {
        ...cap.deps,
        stateDirOverride: "/tmp/s",
        now: () => new Date(0),
      },
    });
    const actor = createActor(m, { inspect: inspector });
    actor.start();
    actor.send({ type: "PING" });

    const stateChangeRows = cap.writes.map((w) => JSON.parse(w.line.trimEnd()));
    // Initial entry only — PING is a self-loop, formatStateValue returns "a" both times.
    expect(stateChangeRows.filter((r) => r.kind === "entry")).toHaveLength(1);
    expect(stateChangeRows.filter((r) => r.kind === "exit")).toHaveLength(0);
  });
});
