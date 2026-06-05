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

describe("prx upgrade self-update alias (prx-1ab, prx-9lc)", () => {
  test("`prx upgrade` updates the coupled prx,ai-home pair via home-update", () => {
    // prx-9lc: prx and ai-home must move together — ai-home consumes prx's hm
    // modules, so bumping only `prx` lets a stale ai-home reference a removed
    // option and abort `home-manager switch`.
    expect(normalizeNamespaceArgv(["upgrade"])).toEqual([
      "home-update",
      "--input",
      "prx,ai-home",
    ]);
  });

  test("tail flags pass through", () => {
    expect(normalizeNamespaceArgv(["upgrade", "--dry-run"])).toEqual([
      "home-update",
      "--input",
      "prx,ai-home",
      "--dry-run",
    ]);
  });

  test("an explicit --input overrides the prx,ai-home default", () => {
    expect(normalizeNamespaceArgv(["upgrade", "--input", "ai-home"])).toEqual([
      "home-update",
      "--input",
      "ai-home",
    ]);
  });
});
