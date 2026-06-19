// HelpAll tests (GH-976) — projection invariants over the registry.

import { describe, expect, test } from "bun:test";

import type { CommandSpec } from "../../../src/cli/registry.ts";
import { prxCommandRegistry } from "../../../src/cli/registry.data.ts";
import { HelpAll } from "../../../src/pr-state/help/help-all.ts";

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

describe("HelpAll", () => {
  test("hides internal:true entries from domain sections", () => {
    const fixture: CommandSpec[] = [
      spec({
        name: "visible-cmd",
        description: "Visible to the operator surface",
        domain: "system",
      }),
      spec({
        name: "hidden-cmd",
        description: "Hidden internal scaffolding only",
        domain: "system",
        internal: true,
      }),
    ];
    const out = HelpAll(fixture);
    expect(out).toContain("prx visible-cmd");
    expect(out).not.toContain("prx hidden-cmd");
  });

  test("hides deprecations from domain sections, surfaces them in deprecation section only (§8)", () => {
    const fixture: CommandSpec[] = [
      spec({
        name: "session open",
        description: "Deprecated alias for plan session",
        domain: "work-units",
        deprecation: {
          alias_for: "plan session",
          removal_target: "#582",
          stderr_hint: "use plan session",
        },
      }),
    ];
    const out = HelpAll(fixture);
    // Deprecated alias appears once: in the deprecation section, not in
    // "Work units:".
    const workUnitsIdx = out.indexOf("Work units:");
    const deprecatedIdx = out.indexOf("Deprecated spellings:");
    expect(workUnitsIdx).toBeGreaterThan(-1);
    expect(deprecatedIdx).toBeGreaterThan(workUnitsIdx);

    const workUnitsSection = out.slice(workUnitsIdx, deprecatedIdx);
    expect(workUnitsSection).not.toContain("prx session open");
    expect(out.slice(deprecatedIdx)).toContain("prx session open");
  });

  test("domain section order matches DOMAIN_ORDER (§7)", () => {
    const out = HelpAll(prxCommandRegistry);
    const stateIdx = out.indexOf("State:");
    const workIdx = out.indexOf("Work units:");
    const repoIdx = out.indexOf("Repo plumbing:");
    const sysIdx = out.indexOf("System:");
    expect(stateIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(workIdx);
    expect(workIdx).toBeLessThan(repoIdx);
    expect(repoIdx).toBeLessThan(sysIdx);
  });

  test("real registry renders every non-internal, non-deprecated entry once", () => {
    const out = HelpAll(prxCommandRegistry);
    const expectedVisible = prxCommandRegistry.filter((c) => !c.internal && !c.deprecation);
    for (const c of expectedVisible) {
      expect(
        out.includes(`prx ${c.name}`),
        `expected '${c.name}' to appear in HelpAll output`,
      ).toBe(true);
    }
  });

  test("real registry surfaces every deprecation in the deprecation section", () => {
    const out = HelpAll(prxCommandRegistry);
    const deprecatedIdx = out.indexOf("Deprecated spellings:");
    expect(deprecatedIdx).toBeGreaterThan(-1);
    const tail = out.slice(deprecatedIdx);
    for (const c of prxCommandRegistry.filter((c) => c.deprecation)) {
      expect(
        tail.includes(`prx ${c.name}`),
        `expected deprecation '${c.name}' in tail section`,
      ).toBe(true);
    }
  });
});
