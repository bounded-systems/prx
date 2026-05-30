import { describe, expect, test } from "bun:test";
import { createActor, waitFor } from "xstate";

import {
  createWorkUnitTuiMachine,
  runClaudeWithProfile,
  type ClaudeRunner,
} from "../../src/pr-state/tui.ts";

function makeRunStub(options: {
  stdout?: string;
  stderr?: string;
  status?: number;
}): ClaudeRunner {
  return async () => ({
    status: options.status ?? 0,
    signal: null,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
  });
}

describe("prx tui runner", () => {
  test("runClaudeWithProfile parses json output", async () => {
    const result = await runClaudeWithProfile({
      agentId: "GH-5195",
      workUnitId: "GH-5195",
      mode: "dev",
      ioFormat: "json",
      run: makeRunStub({ stdout: '{"ok":true}' }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ ok: true });
  });

  test("runClaudeWithProfile parses stream-json output lines", async () => {
    const result = await runClaudeWithProfile({
      agentId: "GH-5195",
      workUnitId: "GH-5195",
      mode: "full",
      ioFormat: "stream-json",
      run: makeRunStub({
        stdout: '{"type":"start"}\n{"type":"end"}\n',
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual([{ type: "start" }, { type: "end" }]);
  });
});

describe("prx tui machine", () => {
  test("transitions idle -> running -> done and stores result", async () => {
    const machine = createWorkUnitTuiMachine({
      runner: async () => ({
        exitCode: 0,
        stdout: '{"ok":true}',
        stderr: "",
        parsed: { ok: true },
      }),
      snapshot: () => ({
        selection: {
          workUnitId: "GH-5195",
          agentId: "GH-5195",
          mode: "full",
          ioFormat: "json",
        },
        controlState: "idle",
        unitState: "committing",
        agentState: "idle",
        mapping: "strict-1:1",
        canRun: true,
        runBlockers: [],
        surface: null,
        surfaceError: null,
        activeRow: null,
        result: null,
        lastError: null,
      }),
    });
    const actor = createActor(machine, {
      input: { workUnitId: "GH-5195" },
    });
    actor.start();
    actor.send({ type: "RUN" });

    await waitFor(actor, (snapshot) => snapshot.matches("done"));
    const snapshot = actor.getSnapshot();
    expect(snapshot.context.result?.parsed).toEqual({ ok: true });
    actor.stop();
  });

  test("enforces strict 1:1 mapping between work unit and agent ids", () => {
    const machine = createWorkUnitTuiMachine({
      runner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        parsed: null,
      }),
    });
    const actor = createActor(machine, {
      input: { workUnitId: "GH-5195" },
    });
    actor.start();
    actor.send({ type: "SET_WORK_UNIT", value: "GH-5431" });
    actor.send({ type: "SET_AGENT", value: "GH-6000" });
    actor.send({ type: "SET_MODE", value: "dev" });
    actor.send({ type: "SET_IO", value: "stream-json" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.workUnitId).toBe("GH-6000");
    expect(snapshot.context.agentId).toBe("GH-6000");
    expect(snapshot.context.mode).toBe("dev");
    expect(snapshot.context.ioFormat).toBe("stream-json");
    actor.stop();
  });

  test("rejects run when snapshot preconditions fail", () => {
    const machine = createWorkUnitTuiMachine({
      runner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        parsed: null,
      }),
      snapshot: () => ({
        selection: {
          workUnitId: "<WORK-UNIT-ID>",
          agentId: "<WORK-UNIT-ID>",
          mode: "full",
          ioFormat: "json",
        },
        controlState: "idle",
        unitState: "unmapped",
        agentState: "idle",
        mapping: "strict-1:1",
        canRun: false,
        runBlockers: ["no canonical work unit selected"],
        surface: null,
        surfaceError: null,
        activeRow: null,
        result: null,
        lastError: null,
      }),
    });
    const actor = createActor(machine, {
      input: { workUnitId: "<WORK-UNIT-ID>" },
    });
    actor.start();
    actor.send({ type: "RUN" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches("idle")).toBe(true);
    expect(snapshot.context.lastError).toBe("run rejected: no canonical work unit selected");
    actor.stop();
  });
});
