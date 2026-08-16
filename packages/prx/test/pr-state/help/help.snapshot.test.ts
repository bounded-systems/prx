// Snapshot tests for `prx --help` and `prx help-all` (GH-976).
//
// These freeze the operator-visible output. The first run generates the
// golden under `__snapshots__/`; subsequent runs guard against regressions.
// Re-run with `bun test test/pr-state/help/help.snapshot.test.ts -u` to
// refresh after an intentional IA change (and document the change against
// `docs/prx/help-surface.md` in the PR).

import { describe, expect, test } from "bun:test";

import { prxCommandRegistry } from "../../../src/cli/registry.data.ts";
import { HelpOverview } from "../../../src/pr-state/help/overview.ts";
import { HelpAll } from "../../../src/pr-state/help/help-all.ts";

describe("help-surface snapshots", () => {
  test("HelpOverview(registry, 'mainx')", () => {
    expect(HelpOverview(prxCommandRegistry, "mainx")).toMatchSnapshot();
  });

  test("HelpAll(registry)", () => {
    expect(HelpAll(prxCommandRegistry)).toMatchSnapshot();
  });
});
