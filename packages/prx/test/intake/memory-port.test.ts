import { describe, expect, test } from "bun:test";
import { makeAgentMemoryPort } from "../../src/intake/memory-port.ts";
import type { CommandRunner } from "@bounded-systems/proc";

type Spawn = { cmd: string[]; env: Record<string, string> | undefined };

/** A CommandRunner that records the argv + env and returns a fixed result. */
function recordingRunner(spawns: Spawn[], status = 0): CommandRunner {
  return ((cmd, options) => {
    spawns.push({ cmd, env: options?.env as Record<string, string> | undefined });
    return { status, stdout: "out", stderr: "" };
  }) as CommandRunner;
}

const emptyEnv = () => ({}) as Record<string, string>;

describe("makeAgentMemoryPort argv mapping", () => {
  test("list without search → `agent-memory list --agent prx`", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).list(undefined, false);
    expect(spawns[0]!.cmd).toEqual(["agent-memory", "list", "--agent", "prx"]);
  });

  test("list with search → `agent-memory search --agent prx --query <q>`", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).list("dolt", false);
    expect(spawns[0]!.cmd).toEqual(["agent-memory", "search", "--agent", "prx", "--query", "dolt"]);
  });

  test("recall → `agent-memory recall --agent prx --key <k>`", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).recall("k", false);
    expect(spawns[0]!.cmd).toEqual(["agent-memory", "recall", "--agent", "prx", "--key", "k"]);
  });

  test("remember → `agent-memory remember --agent prx --key <k> --value <v>`", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).remember("k", "v", false);
    expect(spawns[0]!.cmd).toEqual([
      "agent-memory",
      "remember",
      "--agent",
      "prx",
      "--key",
      "k",
      "--value",
      "v",
    ]);
  });
});

describe("makeAgentMemoryPort json + config", () => {
  test("json=true sets MEMORY_JSON=1 in the child env", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).recall("k", true);
    expect(spawns[0]!.env?.MEMORY_JSON).toBe("1");
  });

  test("json=false does not set MEMORY_JSON", () => {
    const spawns: Spawn[] = [];
    makeAgentMemoryPort({ run: recordingRunner(spawns), env: emptyEnv }).recall("k", false);
    expect(spawns[0]!.env?.MEMORY_JSON).toBeUndefined();
  });

  test("PRX_MEMORY_BIN / PRX_MEMORY_AGENT env override bin + agent", () => {
    const spawns: Spawn[] = [];
    const env = () => ({ PRX_MEMORY_BIN: "/opt/mem", PRX_MEMORY_AGENT: "ops" });
    makeAgentMemoryPort({ run: recordingRunner(spawns), env }).list(undefined, false);
    expect(spawns[0]!.cmd).toEqual(["/opt/mem", "list", "--agent", "ops"]);
  });

  test("explicit deps.bin / deps.agent win over env", () => {
    const spawns: Spawn[] = [];
    const env = () => ({ PRX_MEMORY_BIN: "/opt/mem", PRX_MEMORY_AGENT: "ops" });
    makeAgentMemoryPort({ run: recordingRunner(spawns), env, bin: "am", agent: "planner" }).list(
      undefined,
      false,
    );
    expect(spawns[0]!.cmd).toEqual(["am", "list", "--agent", "planner"]);
  });

  test("exitCode + stdout/stderr are returned from the runner result", () => {
    const spawns: Spawn[] = [];
    const r = makeAgentMemoryPort({ run: recordingRunner(spawns, 2), env: emptyEnv }).recall(
      "k",
      false,
    );
    expect(r).toEqual({ exitCode: 2, stdout: "out", stderr: "" });
  });
});
