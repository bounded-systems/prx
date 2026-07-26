import { describe, expect, test } from "bun:test";
import {
  intakeBdLsOptionsSchema,
  intakeBdMemoryGetOptionsSchema,
  intakeBdMemoryLsOptionsSchema,
  intakeBdMemorySetOptionsSchema,
  runIntakeBdLs,
  runIntakeBdMemoryGet,
  runIntakeBdMemoryLs,
  runIntakeBdMemorySet,
  type IntakeBdLsOptions,
  type IntakeBdMemoryGetOptions,
  type IntakeBdMemoryLsOptions,
  type IntakeBdMemorySetOptions,
} from "../../src/intake/intake-bd.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { MemoryPort, MemoryResult } from "../../src/intake/memory-port.ts";

type BdCall = { subcommand: string; args: string[]; state?: string; role?: string };

function bdOk(stdout = ""): BdExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function bdFail(stderr: string, code = 1): BdExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

// The memory verbs go through a MemoryPort (the agent-memory binary), not
// execBd. Record which port method was invoked and with what arguments.
type MemCall =
  | { method: "list"; search: string | undefined; json: boolean }
  | { method: "recall"; key: string; json: boolean }
  | { method: "remember"; key: string; body: string; json: boolean };

function memOk(stdout = ""): MemoryResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function memFail(stderr: string, code = 1): MemoryResult {
  return { exitCode: code, stdout: "", stderr };
}

/** A MemoryPort that records calls and returns a fixed result. */
function mockMemory(result: MemoryResult, calls: MemCall[]): MemoryPort {
  return {
    list: (search, json) => {
      calls.push({ method: "list", search, json });
      return result;
    },
    recall: (key, json) => {
      calls.push({ method: "recall", key, json });
      return result;
    },
    remember: (key, body, json) => {
      calls.push({ method: "remember", key, body, json });
      return result;
    },
  };
}

function lsOpts(overrides: Partial<IntakeBdLsOptions> = {}): IntakeBdLsOptions {
  return intakeBdLsOptionsSchema.parse({ ...overrides });
}

function memLsOpts(overrides: Partial<IntakeBdMemoryLsOptions> = {}): IntakeBdMemoryLsOptions {
  return intakeBdMemoryLsOptionsSchema.parse({ ...overrides });
}

function memGetOpts(key = "k"): IntakeBdMemoryGetOptions {
  return intakeBdMemoryGetOptionsSchema.parse({ key });
}

function memSetOpts(overrides: Partial<IntakeBdMemorySetOptions> = {}): IntakeBdMemorySetOptions {
  return intakeBdMemorySetOptionsSchema.parse({ key: "k", body: "v", ...overrides });
}

// ---------------------------------------------------------------------------
// schema validation
// ---------------------------------------------------------------------------

describe("intakeBdLsOptionsSchema", () => {
  test("default limit is 20", () => {
    expect(intakeBdLsOptionsSchema.parse({}).limit).toBe(20);
  });

  test("default format is plain", () => {
    expect(intakeBdLsOptionsSchema.parse({}).format).toBe("plain");
  });

  test("accepts arbitrary --status (validation deferred to bd)", () => {
    expect(intakeBdLsOptionsSchema.parse({ status: "open,in_progress,pinned" }).status).toBe(
      "open,in_progress,pinned",
    );
  });

  test("rejects empty --status string", () => {
    expect(() => intakeBdLsOptionsSchema.parse({ status: "" })).toThrow();
  });

  test("rejects negative --limit", () => {
    expect(() => intakeBdLsOptionsSchema.parse({ limit: -1 })).toThrow();
  });
});

describe("intakeBdMemoryGetOptionsSchema", () => {
  test("rejects empty key", () => {
    expect(() => intakeBdMemoryGetOptionsSchema.parse({ key: "" })).toThrow();
  });
});

describe("intakeBdMemorySetOptionsSchema", () => {
  test("rejects empty key", () => {
    expect(() => intakeBdMemorySetOptionsSchema.parse({ key: "", body: "v" })).toThrow();
  });

  test("rejects empty body", () => {
    expect(() => intakeBdMemorySetOptionsSchema.parse({ key: "k", body: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdLs
// ---------------------------------------------------------------------------

describe("runIntakeBdLs", () => {
  test("calls bd list with --limit 20 by default and prints stdout", () => {
    const calls: BdCall[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeBdLs(
      lsOpts(),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("the listing\n");
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subcommand).toBe("list");
    expect(calls[0]!.args).toEqual(["--limit", "20"]);
    expect(calls[0]!.state).toBe("planning");
    expect(calls[0]!.role).toBe("planner");
    expect(logs[0]).toBe("the listing");
  });

  test("--status forwards as --status to bd", () => {
    const calls: BdCall[] = [];
    runIntakeBdLs(
      lsOpts({ status: "in_progress" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["--limit", "20", "--status", "in_progress"]);
  });

  test("--limit overrides default", () => {
    const calls: BdCall[] = [];
    runIntakeBdLs(
      lsOpts({ limit: 5 }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["--limit", "5"]);
  });

  test("format=json appends --json to bd args and passes stdout through", () => {
    const calls: BdCall[] = [];
    const logs: string[] = [];
    runIntakeBdLs(
      lsOpts({ format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk('[{"id":"x"}]\n');
        }) as never,
      },
    );
    expect(calls[0]!.args).toContain("--json");
    expect(logs[0]).toBe('[{"id":"x"}]');
    expect(JSON.parse(logs[0]!)).toEqual([{ id: "x" }]);
  });

  test("bd unreachable surfaces a single warning line and propagates exit code", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdLs(
      lsOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execBd: (() => bdFail("bd: cannot reach dolt", 2)) as never,
      },
    );
    expect(exitCode).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("prx intake bd ls");
    expect(errors[0]).toContain("bd: cannot reach dolt");
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdMemoryLs
// ---------------------------------------------------------------------------

describe("runIntakeBdMemoryLs", () => {
  test("no search → memory.list(undefined)", () => {
    const calls: MemCall[] = [];
    runIntakeBdMemoryLs(
      memLsOpts(),
      { log: () => undefined, error: () => undefined },
      { memory: mockMemory(memOk(""), calls) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "list", search: undefined, json: false });
  });

  test("search positional → memory.list(<search>)", () => {
    const calls: MemCall[] = [];
    runIntakeBdMemoryLs(
      memLsOpts({ search: "dolt" }),
      { log: () => undefined, error: () => undefined },
      { memory: mockMemory(memOk(""), calls) },
    );
    expect(calls[0]).toEqual({ method: "list", search: "dolt", json: false });
  });

  test("format=json requests json output and passes stdout through", () => {
    const calls: MemCall[] = [];
    const logs: string[] = [];
    runIntakeBdMemoryLs(
      memLsOpts({ format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      { memory: mockMemory(memOk('{"count":0,"memories":[]}'), calls) },
    );
    expect(calls[0]).toEqual({ method: "list", search: undefined, json: true });
    expect(JSON.parse(logs[0]!)).toEqual({ count: 0, memories: [] });
  });

  test("memory failure → single warning line + non-zero exit", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemoryLs(
      memLsOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      { memory: mockMemory(memFail("agent-memory unreachable", 1), []) },
    );
    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("prx intake bd memory ls");
    expect(errors[0]).toContain("agent-memory unreachable");
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdMemoryGet
// ---------------------------------------------------------------------------

describe("runIntakeBdMemoryGet", () => {
  test("calls memory.recall(<key>) and passes stdout through", () => {
    const calls: MemCall[] = [];
    const logs: string[] = [];
    runIntakeBdMemoryGet(
      memGetOpts("dolt-phantoms"),
      { log: (l) => logs.push(l), error: () => undefined },
      { memory: mockMemory(memOk("the body\n"), calls) },
    );
    expect(calls[0]).toEqual({ method: "recall", key: "dolt-phantoms", json: false });
    expect(logs[0]).toBe("the body");
  });

  test("format=json requests json output", () => {
    const calls: MemCall[] = [];
    runIntakeBdMemoryGet(
      intakeBdMemoryGetOptionsSchema.parse({ key: "k", format: "json" }),
      { log: () => undefined, error: () => undefined },
      { memory: mockMemory(memOk("{}"), calls) },
    );
    expect(calls[0]).toEqual({ method: "recall", key: "k", json: true });
  });

  test("missing key (memory exit non-zero) surfaces the error line", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemoryGet(
      memGetOpts("nope"),
      { log: () => undefined, error: (l) => errors.push(l) },
      { memory: mockMemory(memFail("memory not found: nope", 1), []) },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("memory not found: nope");
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdMemorySet
// ---------------------------------------------------------------------------

describe("runIntakeBdMemorySet", () => {
  test("calls memory.remember(<key>, <body>)", () => {
    const calls: MemCall[] = [];
    runIntakeBdMemorySet(
      memSetOpts({ key: "k1", body: "the value" }),
      { log: () => undefined, error: () => undefined },
      { memory: mockMemory(memOk("ok\n"), calls) },
    );
    expect(calls[0]).toEqual({
      method: "remember",
      key: "k1",
      body: "the value",
      json: false,
    });
  });

  test("format=json requests json output", () => {
    const calls: MemCall[] = [];
    runIntakeBdMemorySet(
      intakeBdMemorySetOptionsSchema.parse({ key: "k", body: "v", format: "json" }),
      { log: () => undefined, error: () => undefined },
      { memory: mockMemory(memOk("{}"), calls) },
    );
    expect(calls[0]).toEqual({ method: "remember", key: "k", body: "v", json: true });
  });

  test("memory failure → single warning line + propagated exit code", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemorySet(
      memSetOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      { memory: mockMemory(memFail("write blocked", 3), []) },
    );
    expect(exitCode).toBe(3);
    expect(errors[0]).toContain("prx intake bd memory set");
    expect(errors[0]).toContain("write blocked");
  });
});
