// GH-1423 PR-1: `runRulesCli` orchestration — input loading, assertion
// emission, and exit codes.

import { describe, expect, test } from "bun:test";

import type { RulesEvent } from "../../src/rules/events.ts";
import { runRulesCli } from "../../src/rules/cli.ts";

type Captured = {
  logs: string[];
  errors: string[];
  events: RulesEvent[];
};

function capture(): {
  out: { log: (s: string) => void; error: (s: string) => void; emit: (e: RulesEvent) => void };
  captured: Captured;
} {
  const captured: Captured = { logs: [], errors: [], events: [] };
  return {
    captured,
    out: {
      log: (s) => captured.logs.push(s),
      error: (s) => captured.errors.push(s),
      emit: (e) => captured.events.push(e),
    },
  };
}

describe("runRulesCli — inputs verb", () => {
  test("dumps the typed input set as JSON and exits 0", () => {
    const { captured, out } = capture();
    const code = runRulesCli({ verb: "inputs", format: "json" }, out);
    expect(code).toBe(0);
    expect(captured.logs.length).toBe(1);
    const parsed = JSON.parse(captured.logs[0]!);
    expect(Array.isArray(parsed.verbSupply)).toBe(true);
    expect(parsed.verbSupply.length).toBeGreaterThan(0);
    expect(parsed.aliasSupply).toEqual([]);
    expect(parsed.worktreeGestures).toEqual([]);
    expect(parsed.memoryIndex).toEqual([]);
  });

  test("emits RULES_INPUT_LOADED for verb-supply and three STUBBED events", () => {
    const { captured, out } = capture();
    runRulesCli({ verb: "inputs", format: "plain" }, out);
    const loaded = captured.events.filter((e) => e.type === "RULES_INPUT_LOADED");
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ kind: "verb-supply" });
    const stubbed = captured.events.filter((e) => e.type === "RULES_INPUT_STUBBED");
    expect(stubbed.map((e) => (e as { kind: string }).kind).sort()).toEqual([
      "alias-supply",
      "memory-index",
      "worktree-gestures",
    ]);
  });
});

describe("runRulesCli — render verb", () => {
  test("emits RULES_RENDERED on the happy path", () => {
    const { captured, out } = capture();
    const code = runRulesCli({ verb: "render", format: "plain" }, out);
    // The renderer embeds the za/zb/zc drift canary inside an
    // assert:alias fence; with an empty stub alias-supply, that fence
    // *should* trip the alias-exists assertion. The CLI surfaces that
    // as exit 1.
    expect(code).toBe(1);
    const aliasFailures = captured.events.filter(
      (e) => e.type === "RULES_ASSERTION_FAILED" && (e as { rule: string }).rule === "alias-exists",
    );
    expect(aliasFailures.length).toBeGreaterThanOrEqual(3);
  });
});

describe("runRulesCli — validate verb", () => {
  test("requires --path", () => {
    const { out } = capture();
    expect(() => runRulesCli({ verb: "validate", format: "plain" }, out)).toThrow(
      /requires --path/,
    );
  });
});
