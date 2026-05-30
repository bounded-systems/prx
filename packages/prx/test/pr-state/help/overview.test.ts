// HelpOverview tests (GH-976) — projection invariants over the registry.

import { describe, expect, test } from "bun:test";

import type { CommandSpec } from "../../../src/cli/registry.ts";
import {
  prxCommandRegistry,
  promotedFor,
} from "../../../src/cli/registry.data.ts";
import { HelpOverview } from "../../../src/pr-state/help/overview.ts";

const spec = (over: Partial<CommandSpec>): CommandSpec => ({
  name: "x",
  description: "a sample valid description",
  domain: "system",
  promoted_in: [],
  binding: "none",
  internal: false,
  actor: "tools",
  ...over,
});

describe("HelpOverview", () => {
  test("filters by promoted_in.includes(ctx)", () => {
    const fixture: CommandSpec[] = [
      spec({ name: "promoted-mainx", description: "Promoted in mainx context", promoted_in: ["mainx"] }),
      spec({ name: "promoted-plan", description: "Promoted only in plan ctx", promoted_in: ["plan"] }),
      spec({ name: "unpromoted", description: "Never appears in any overview" }),
    ];
    const out = HelpOverview(fixture, "mainx");
    expect(out).toContain("prx promoted-mainx");
    expect(out).not.toContain("prx promoted-plan");
    expect(out).not.toContain("prx unpromoted");
  });

  test("excludes deprecation entries even when promoted (drift guard)", () => {
    const fixture: CommandSpec[] = [
      spec({
        name: "session open",
        description: "Deprecated alias for plan session",
        promoted_in: ["mainx"],
        deprecation: {
          alias_for: "plan session",
          removal_target: "#582",
          stderr_hint: "use plan session",
        },
      }),
      spec({ name: "plan session", description: "Open plan-mode work session for a unit", promoted_in: ["mainx"] }),
    ];
    const out = HelpOverview(fixture, "mainx");
    expect(out).not.toContain("prx session open");
    expect(out).toContain("prx plan session");
  });

  test("output for ctx=mainx differs from ctx=plan (forward-compat with #977)", () => {
    const fixture: CommandSpec[] = [
      spec({ name: "tui", description: "Mainx promoted entry sample", promoted_in: ["mainx"] }),
      spec({ name: "plan apply", description: "Plan-context promoted entry sample", promoted_in: ["plan"] }),
    ];
    const mainxOut = HelpOverview(fixture, "mainx");
    const planOut = HelpOverview(fixture, "plan");
    expect(mainxOut).not.toBe(planOut);
    expect(mainxOut).toContain("prx tui");
    expect(planOut).toContain("prx plan apply");
  });

  test("real registry + mainx renders the canonical six in promotedFor order", () => {
    const out = HelpOverview(prxCommandRegistry, "mainx");
    const expected = promotedFor("mainx").map((c) => c.name);
    expect(expected).toHaveLength(6);
    // Find each promoted name in the rendered output, in order.
    let cursor = 0;
    for (const name of expected) {
      const idx = out.indexOf(`prx ${name}`, cursor);
      expect(
        idx,
        `expected '${name}' to appear at or after offset ${cursor}`,
      ).toBeGreaterThan(-1);
      cursor = idx + name.length;
    }
  });

  test("includes identity at the top (§6.1)", () => {
    const out = HelpOverview(prxCommandRegistry, "mainx");
    const headerEnd = out.indexOf("==========");
    const identityIdx = out.indexOf("Work-unit identity");
    const promotedIdx = out.indexOf("Primary workflow:");
    expect(headerEnd).toBeGreaterThan(-1);
    expect(identityIdx).toBeGreaterThan(headerEnd);
    expect(identityIdx).toBeLessThan(promotedIdx);
  });
});
