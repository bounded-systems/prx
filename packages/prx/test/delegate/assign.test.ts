import { describe, expect, test } from "bun:test";

import { runDelegateAssign } from "../../src/delegate/assign.ts";

// GH-1012: the bd assignment write plane (and the bd `show` eligibility read)
// has been removed. `runDelegateAssign` no longer runs any sync runner or bd
// show — it validates the request (mode gating, `--self` login resolution,
// agent trimming) and reports the intended assignment without mutating. These
// tests pin that non-bd behavior.

describe("runDelegateAssign — mode dispatch", () => {
  test("no mode → exit 2 usage", () => {
    const result = runDelegateAssign({ id: "GH-1", repoPath: "." });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/requires one of/);
  });

  test("multi-mode (--self + --unassign) → exit 2 usage", () => {
    const result = runDelegateAssign({
      id: "GH-1",
      self: true,
      unassign: true,
      repoPath: ".",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/exactly one/);
  });

  test("agent + --unassign → exit 2 usage", () => {
    const result = runDelegateAssign({
      id: "GH-1",
      agent: "alice",
      unassign: true,
      repoPath: ".",
    });
    expect(result.exitCode).toBe(2);
  });

  test("empty agent string → exit 2 usage", () => {
    const result = runDelegateAssign({ id: "GH-1", agent: "   ", repoPath: "." });
    expect(result.exitCode).toBe(2);
  });
});

describe("runDelegateAssign — bd-native id passthrough (supply-plan-design-6nd)", () => {
  // assign.ts has no GH-specific parsing anywhere — `id` is an opaque string.
  // This pins that a plain bd id (the `<prefix>-<short>` shape) works end to
  // end, identically to the GH-form ids exercised elsewhere in this file.
  test("happy path: assigns via a plain bd-native id, not just GH-form", () => {
    const result = runDelegateAssign({
      id: "supply-plan-design-3pc",
      agent: "bdelanghe",
      repoPath: "/repo",
    });
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated supply-plan-design-3pc → bdelanghe",
    });
  });
});

describe("runDelegateAssign — agent passthrough", () => {
  test("happy path: assigns the named agent", () => {
    const result = runDelegateAssign({ id: "GH-456", agent: "alice", repoPath: "/repo" });
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated GH-456 → alice",
    });
  });

  test("agent name is trimmed", () => {
    const result = runDelegateAssign({ id: "GH-1", agent: "  bob  ", repoPath: "." });
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated GH-1 → bob",
    });
  });
});

describe("runDelegateAssign — --self resolver (GH-2012 login-shape)", () => {
  test("--self resolves to GH login and assigns", () => {
    const result = runDelegateAssign(
      { id: "GH-1", self: true, repoPath: "." },
      { resolveSelfOperator: () => ({ ok: true, agent: "bdelanghe" }) },
    );
    expect(result).toEqual({
      exitCode: 0,
      message: "delegated GH-1 → bdelanghe",
    });
  });

  test("--self resolver failure → exit 1 with resolver message", () => {
    const result = runDelegateAssign(
      { id: "GH-1", self: true, repoPath: "." },
      {
        resolveSelfOperator: () => ({
          ok: false,
          message: "gh auth status failed — run `gh auth login`",
        }),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/gh auth status/);
  });
});

describe("runDelegateAssign — --unassign", () => {
  test("--unassign reports cleared", () => {
    const result = runDelegateAssign({ id: "GH-9", unassign: true, repoPath: "/r" });
    expect(result).toEqual({
      exitCode: 0,
      message: "unassigned GH-9",
    });
  });
});
