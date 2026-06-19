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

type BdCall = { subcommand: string; args: string[]; state?: string; role?: string };

function bdOk(stdout = ""): BdExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function bdFail(stderr: string, code = 1): BdExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
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
  test("no search forwards no positional", () => {
    const calls: BdCall[] = [];
    runIntakeBdMemoryLs(
      memLsOpts(),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("");
        }) as never,
      },
    );
    expect(calls[0]!.subcommand).toBe("memories");
    expect(calls[0]!.args).toEqual([]);
  });

  test("search positional forwards as bd memories <search>", () => {
    const calls: BdCall[] = [];
    runIntakeBdMemoryLs(
      memLsOpts({ search: "dolt" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["dolt"]);
  });

  test("format=json appends --json", () => {
    const calls: BdCall[] = [];
    runIntakeBdMemoryLs(
      memLsOpts({ format: "json" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("[]");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["--json"]);
  });

  test("bd failure → single warning line + non-zero exit", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemoryLs(
      memLsOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execBd: (() => bdFail("bd unreachable", 1)) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("prx intake bd memory ls");
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdMemoryGet
// ---------------------------------------------------------------------------

describe("runIntakeBdMemoryGet", () => {
  test("calls bd recall <key>", () => {
    const calls: BdCall[] = [];
    const logs: string[] = [];
    runIntakeBdMemoryGet(
      memGetOpts("dolt-phantoms"),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("the body\n");
        }) as never,
      },
    );
    expect(calls[0]!.subcommand).toBe("recall");
    expect(calls[0]!.args).toEqual(["dolt-phantoms"]);
    expect(logs[0]).toBe("the body");
  });

  test("format=json appends --json", () => {
    const calls: BdCall[] = [];
    runIntakeBdMemoryGet(
      intakeBdMemoryGetOptionsSchema.parse({ key: "k", format: "json" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("{}");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["k", "--json"]);
  });

  test("missing key (bd exit non-zero) surfaces the error line", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemoryGet(
      memGetOpts("nope"),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execBd: (() => bdFail("memory not found: nope", 1)) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("memory not found: nope");
  });
});

// ---------------------------------------------------------------------------
// runIntakeBdMemorySet
// ---------------------------------------------------------------------------

describe("runIntakeBdMemorySet", () => {
  test('calls bd remember "<body>" --key <key>', () => {
    const calls: BdCall[] = [];
    runIntakeBdMemorySet(
      memSetOpts({ key: "k1", body: "the value" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("ok\n");
        }) as never,
      },
    );
    expect(calls[0]!.subcommand).toBe("remember");
    expect(calls[0]!.args).toEqual(["the value", "--key", "k1"]);
  });

  test("format=json appends --json", () => {
    const calls: BdCall[] = [];
    runIntakeBdMemorySet(
      intakeBdMemorySetOptionsSchema.parse({ key: "k", body: "v", format: "json" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: ((opts: BdCall) => {
          calls.push(opts);
          return bdOk("{}");
        }) as never,
      },
    );
    expect(calls[0]!.args).toEqual(["v", "--key", "k", "--json"]);
  });

  test("bd failure → single warning line + propagated exit code", () => {
    const errors: string[] = [];
    const exitCode = runIntakeBdMemorySet(
      memSetOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execBd: (() => bdFail("write blocked", 3)) as never,
      },
    );
    expect(exitCode).toBe(3);
    expect(errors[0]).toContain("prx intake bd memory set");
    expect(errors[0]).toContain("write blocked");
  });
});
