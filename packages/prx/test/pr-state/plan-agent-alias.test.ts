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
    expect(normalizeNamespaceArgv(["plan", "agent", "GH-1"])).toEqual(["plan-session", "GH-1"]);
    expect(normalizeNamespaceArgv(["plan", "agent", "GH-1"])).toEqual(
      normalizeNamespaceArgv(["plan", "session", "GH-1"]),
    );
  });

  test("`plan agent --interactive` still opts into the tmux session", () => {
    expect(normalizeNamespaceArgv(["plan", "agent", "GH-1", "--interactive"])).toEqual([
      "plan-session",
      "GH-1",
      "--interactive",
    ]);
  });

  test("`plan` with no subcommand lists `agent` as an option", () => {
    expect(() => normalizeNamespaceArgv(["plan"])).toThrow(/agent/);
  });
});

describe("retired home verbs", () => {
  // `prx home update`, `prx home sync`, and `prx upgrade` all routed through a
  // single `home-update` handler that shelled out to `home-manager switch`
  // against a flake dir prx guessed. All three are gone, so none of them
  // normalize to anything — they fall through as ordinary unknown commands.
  test("`prx upgrade` is no longer a namespace alias", () => {
    expect(normalizeNamespaceArgv(["upgrade"])).toEqual(["upgrade"]);
  });

  test("`prx home` is no longer a namespace", () => {
    expect(normalizeNamespaceArgv(["home", "update"])).toEqual(["home", "update"]);
  });
});
