/**
 * prx-383 — `prx plan agent` closes the last gap in the uniform
 * `prx <actor> agent` chain. It is a synonym for the plan-session engine (whose
 * default is the non-interactive --print headless plan), so every lifecycle step
 * is now `prx <actor> agent`: intake → triage → plan → implement → submit → author.
 */
import { describe, expect, test } from "bun:test";

import { normalizeNamespaceArgv } from "../../src/pr-state/cli.ts";

describe("prx plan agent alias (prx-383)", () => {
  test("`plan agent <id>` normalizes to the plan-session engine, like `plan session`", () => {
    expect(normalizeNamespaceArgv(["plan", "agent", "GH-1"])).toEqual([
      "plan-session",
      "GH-1",
    ]);
    expect(normalizeNamespaceArgv(["plan", "agent", "GH-1"])).toEqual(
      normalizeNamespaceArgv(["plan", "session", "GH-1"]),
    );
  });

  test("`plan agent --interactive` still opts into the tmux session", () => {
    expect(
      normalizeNamespaceArgv(["plan", "agent", "GH-1", "--interactive"]),
    ).toEqual(["plan-session", "GH-1", "--interactive"]);
  });

  test("`plan` with no subcommand lists `agent` as an option", () => {
    expect(() => normalizeNamespaceArgv(["plan"])).toThrow(/agent/);
  });
});

describe("prx upgrade self-update alias (prx-1ab, prx-9lc, GH-411 slice 3)", () => {
  test("`prx upgrade` passes through to home-update (coupled set comes from config)", () => {
    // GH-411 slice 3: the coupled input set is no longer hardcoded here —
    // home-update resolves it from `homeUpdate.inputs` in ~/.config/prx/config.json
    // (falling back to `["prx"]`). `prx upgrade` is now a thin alias.
    expect(normalizeNamespaceArgv(["upgrade"])).toEqual(["home-update"]);
  });

  test("tail flags pass through", () => {
    expect(normalizeNamespaceArgv(["upgrade", "--dry-run"])).toEqual([
      "home-update",
      "--dry-run",
    ]);
  });

  test("an explicit --input still overrides the configured set", () => {
    expect(normalizeNamespaceArgv(["upgrade", "--input", "ai-home"])).toEqual([
      "home-update",
      "--input",
      "ai-home",
    ]);
  });
});
