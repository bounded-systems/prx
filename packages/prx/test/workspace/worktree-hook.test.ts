import { describe, expect, test } from "bun:test";

import {
  buildWorktreeHookSettings,
  parseWorktreeEnvelope,
  runWorktreeCreateHook,
  runWorktreeRemoveHook,
} from "../../src/workspace/worktree-hook.ts";

// ai-home-ozbjp — envelope-first tests for the workcell worktree hooks. Mock
// the Claude Code envelope + the runtime port; the real reserve→materialize
// wiring is the deferred "runtime satisfies the envelope" slice.

describe("parseWorktreeEnvelope", () => {
  test("parses name (create) and worktree_path (remove)", () => {
    expect(parseWorktreeEnvelope(JSON.stringify({ name: "feat-x" })).name).toBe("feat-x");
    expect(
      parseWorktreeEnvelope(JSON.stringify({ worktree_path: "/w/x" })).worktree_path,
    ).toBe("/w/x");
  });

  test("tolerates empty / malformed input", () => {
    expect(parseWorktreeEnvelope("")).toEqual({});
    expect(parseWorktreeEnvelope("not json")).toEqual({});
    expect(parseWorktreeEnvelope("42")).toEqual({});
  });
});

describe("runWorktreeCreateHook (ai-home-ozbjp)", () => {
  test("materializes via the port and prints the path on stdout (exit 0)", async () => {
    const seen: string[] = [];
    const r = await runWorktreeCreateHook({
      stdin: JSON.stringify({ hook_event_name: "WorktreeCreate", name: "GH-5/plan" }),
      materialize: async (name) => {
        seen.push(name);
        return "/work/GH-5/plan";
      },
    });
    expect(r).toEqual({ exitCode: 0, stream: "stdout", message: "/work/GH-5/plan" });
    expect(seen).toEqual(["GH-5/plan"]);
  });

  test("missing name → non-zero (aborts creation), port not called", async () => {
    let called = false;
    const r = await runWorktreeCreateHook({
      stdin: JSON.stringify({ hook_event_name: "WorktreeCreate" }),
      materialize: async () => {
        called = true;
        return "/x";
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stream).toBe("stderr");
    expect(called).toBe(false);
  });

  test("materialize failure → non-zero with reason (aborts creation)", async () => {
    const r = await runWorktreeCreateHook({
      stdin: JSON.stringify({ name: "GH-9" }),
      materialize: async () => {
        throw new Error("no reserved ledger");
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toContain("no reserved ledger");
  });

  test("empty path from port → non-zero (no path == creation fails)", async () => {
    const r = await runWorktreeCreateHook({
      stdin: JSON.stringify({ name: "GH-9" }),
      materialize: async () => "",
    });
    expect(r.exitCode).not.toBe(0);
  });
});

describe("runWorktreeRemoveHook (ai-home-ozbjp)", () => {
  test("tears down via the port (exit 0 — no decision control)", async () => {
    const seen: string[] = [];
    const r = await runWorktreeRemoveHook({
      stdin: JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: "/work/GH-5/plan" }),
      teardown: async (p) => {
        seen.push(p);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual(["/work/GH-5/plan"]);
  });

  test("teardown failure is non-blocking (still exit 0, reported to stderr)", async () => {
    const r = await runWorktreeRemoveHook({
      stdin: JSON.stringify({ worktree_path: "/w/x" }),
      teardown: async () => {
        throw new Error("locked");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stream).toBe("stderr");
    expect(r.message).toContain("locked");
  });

  test("missing worktree_path → no-op (exit 0)", async () => {
    let called = false;
    const r = await runWorktreeRemoveHook({
      stdin: "{}",
      teardown: async () => {
        called = true;
      },
    });
    expect(r.exitCode).toBe(0);
    expect(called).toBe(false);
  });
});

describe("buildWorktreeHookSettings (ai-home-ozbjp)", () => {
  test("registers both WorktreeCreate and WorktreeRemove command hooks", () => {
    const s = buildWorktreeHookSettings("bun /x/create.ts", "bun /x/remove.ts");
    expect(s.hooks.WorktreeCreate[0]!.hooks[0]!.command).toBe("bun /x/create.ts");
    expect(s.hooks.WorktreeRemove[0]!.hooks[0]!.command).toBe("bun /x/remove.ts");
    expect(s.hooks.WorktreeCreate[0]!.hooks[0]!.type).toBe("command");
  });
});
