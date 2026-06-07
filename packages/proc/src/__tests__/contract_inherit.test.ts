// localProcExecutor stdio:"inherit" — the one non-remote-able mode that wires
// the child straight to this process's terminal. Covers the inherit branch:
// a clean exit and a spawn error (binary not found).

import { describe, expect, test } from "bun:test";

import { localProcExecutor } from "../contract.ts";

describe("localProcExecutor stdio:inherit", () => {
  test("a clean inherit-stdio child resolves with status 0 and empty buffers", async () => {
    const result = await localProcExecutor().exec({
      command: "true",
      args: [],
      stdio: "inherit",
    });
    expect(result.status).toBe(0);
    // inherit wires the terminal, so nothing is captured into the result.
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("a non-zero inherit-stdio child reports its exit status", async () => {
    const result = await localProcExecutor().exec({
      command: "false",
      args: [],
      stdio: "inherit",
    });
    expect(result.status).toBe(1);
  });

  test("a spawn error (missing binary) resolves to status 1", async () => {
    const result = await localProcExecutor().exec({
      command: "prx-definitely-not-a-real-binary-xyz",
      args: [],
      stdio: "inherit",
    });
    expect(result.status).toBe(1);
  });
});
