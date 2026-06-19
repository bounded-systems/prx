// GH-1003: parser-routing tests for `prx intake bd …`. The leaf-handler tests
// in test/intake/intake-bd.test.ts cover schemas/handlers directly; this file
// drives the public CLI seam (`runCli`) so a regression in `parseCommand`
// ordering or error messages is caught here.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import type { BdExecResult } from "@bounded-systems/bd";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

function bdOk(stdout = ""): BdExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

describe("runCli — `prx intake bd` parser routing", () => {
  test("routes `intake bd ls` to the ls handler with --limit 20 default", async () => {
    const { output } = captureOutput();
    const captured: Array<{ args: string[] }> = [];
    const exit = await runCli(["intake", "bd", "ls"], output, {
      runIntakeBdLs: (opts, _o, _deps) => {
        captured.push({ args: ["--limit", String(opts.limit)] });
        return 0;
      },
    });
    expect(exit).toBe(0);
    expect(captured).toEqual([{ args: ["--limit", "20"] }]);
  });

  test("`intake bd ls --status` forwards the status string to the schema", async () => {
    const { output } = captureOutput();
    const captured: Array<{ status?: string | undefined; limit: number }> = [];
    const exit = await runCli(
      ["intake", "bd", "ls", "--status", "in_progress", "--limit", "3"],
      output,
      {
        runIntakeBdLs: (opts) => {
          captured.push({ status: opts.status, limit: opts.limit });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ status: "in_progress", limit: 3 }]);
  });

  test("`intake bd ls --limit 1.5` is rejected (no silent truncation)", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "ls", "--limit", "1.5"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("--limit must be a non-negative integer"))).toBe(true);
  });

  test("`--json` flag flips format to json before dispatch", async () => {
    const { output } = captureOutput();
    const captured: string[] = [];
    await runCli(["intake", "bd", "ls", "--json"], output, {
      runIntakeBdLs: (opts) => {
        captured.push(opts.format);
        return 0;
      },
    });
    expect(captured).toEqual(["json"]);
  });

  test("routes `intake bd memory ls <search>` with the search positional", async () => {
    const { output } = captureOutput();
    const captured: Array<string | undefined> = [];
    await runCli(["intake", "bd", "memory", "ls", "dolt"], output, {
      runIntakeBdMemoryLs: (opts) => {
        captured.push(opts.search);
        return 0;
      },
    });
    expect(captured).toEqual(["dolt"]);
  });

  test("routes `intake bd memory get <key>`", async () => {
    const { output } = captureOutput();
    const captured: string[] = [];
    await runCli(["intake", "bd", "memory", "get", "the-key"], output, {
      runIntakeBdMemoryGet: (opts) => {
        captured.push(opts.key);
        return 0;
      },
    });
    expect(captured).toEqual(["the-key"]);
  });

  test("`intake bd memory get` without a positional reports missing-key error", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "memory", "get"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("requires a <key>"))).toBe(true);
  });

  test("routes `intake bd memory set <key> --body <text>`", async () => {
    const { output } = captureOutput();
    const captured: Array<{ key: string; body: string }> = [];
    await runCli(["intake", "bd", "memory", "set", "the-key", "--body", "the value"], output, {
      runIntakeBdMemorySet: (opts) => {
        captured.push({ key: opts.key, body: opts.body });
        return 0;
      },
    });
    expect(captured).toEqual([{ key: "the-key", body: "the value" }]);
  });

  test("`intake bd memory set` without --body errors at parse time", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "memory", "set", "the-key"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("requires --body"))).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Verb-layer rejection: bd close / forget / github sync are intentionally
  // not exposed under `prx intake bd`. Each must produce the routing error
  // (no path through to execBd).
  // ---------------------------------------------------------------------

  test("`intake bd close 1` is rejected at the verb layer", async () => {
    const { errors, output } = captureOutput();
    let bdCalled = false;
    const exit = await runCli(["intake", "bd", "close", "1"], output, {
      runIntakeBdLs: () => {
        bdCalled = true;
        return 0;
      },
    });
    expect(exit).not.toBe(0);
    expect(bdCalled).toBe(false);
    expect(errors.some((l) => l.includes("unknown subcommand 'close'"))).toBe(true);
  });

  test("`intake bd github sync` is rejected at the verb layer", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "github", "sync"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("unknown subcommand 'github'"))).toBe(true);
  });

  test("`intake bd forget some-key` is rejected at the verb layer", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "forget", "some-key"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("unknown subcommand 'forget'"))).toBe(true);
  });

  test("`intake bd memory unknown` is rejected at the memory verb layer", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "bd", "memory", "delete", "k"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("intake bd memory: unknown subcommand 'delete'"))).toBe(
      true,
    );
  });

  test("schema-validated options pass through dispatch unchanged", async () => {
    const { output } = captureOutput();
    const captured: Array<{ status?: string | undefined; limit: number; format: string }> = [];
    const exit = await runCli(
      ["intake", "bd", "ls", "--status", "open", "--limit", "5", "--json"],
      output,
      {
        runIntakeBdLs: (o) => {
          captured.push({ status: o.status, limit: o.limit, format: o.format });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ status: "open", limit: 5, format: "json" }]);
    void bdOk;
  });
});
