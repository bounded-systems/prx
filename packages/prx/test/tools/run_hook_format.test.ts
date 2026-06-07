// tools/run_hook — isBuiltinHookEvent + the pure formatRunHookResult renderer
// (json + every skipped/override/builtin plain branch).

import { describe, expect, test } from "bun:test";

import { formatRunHookResult, isBuiltinHookEvent } from "../../src/tools/run_hook.ts";
import type { RunHookResult } from "../../src/tools/run_hook.ts";

const r = (o: Partial<RunHookResult>): RunHookResult => ({ event: "e", ...o }) as RunHookResult;

describe("isBuiltinHookEvent", () => {
  test("true for a built-in event, false otherwise", () => {
    expect(isBuiltinHookEvent("ensure-claude-settings")).toBe(true);
    expect(isBuiltinHookEvent("totally-made-up")).toBe(false);
  });
});

describe("formatRunHookResult", () => {
  test("json format round-trips the result", () => {
    const out = formatRunHookResult(r({ source: "builtin", exitCode: 0 }), "json");
    expect(JSON.parse(out).source).toBe("builtin");
  });

  test("skipped: no-repo", () => {
    expect(formatRunHookResult(r({ source: "skipped", reason: "no-repo" }), "plain")).toContain("not inside a git repository");
  });
  test("skipped: unknown-event names the overlay path", () => {
    const out = formatRunHookResult(r({ source: "skipped", reason: "unknown-event", overridePath: "/o/h" }), "plain");
    expect(out).toContain("no built-in and no override at /o/h");
  });
  test("skipped: unknown-event with no overlay path", () => {
    expect(formatRunHookResult(r({ source: "skipped", reason: "unknown-event" }), "plain")).toContain("<no overlay>");
  });
  test("skipped: override-not-executable", () => {
    expect(formatRunHookResult(r({ source: "skipped", reason: "override-not-executable", overridePath: "/o/h" }), "plain")).toContain("not executable");
  });
  test("skipped: other reason falls back", () => {
    expect(formatRunHookResult(r({ source: "skipped", reason: "other" as never }), "plain")).toContain("skipped");
  });
  test("override names the path + exit", () => {
    expect(formatRunHookResult(r({ source: "override", overridePath: "/o/h", exitCode: 3 }), "plain")).toContain("ran override /o/h (exit 3)");
  });
  test("builtin names the exit", () => {
    expect(formatRunHookResult(r({ source: "builtin", exitCode: 0 }), "plain")).toContain("ran built-in (exit 0)");
  });
});
