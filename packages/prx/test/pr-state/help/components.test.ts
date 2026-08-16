// Help-surface component tests (GH-976).

import { describe, expect, test } from "bun:test";

import type { CommandSpec } from "../../../src/cli/registry.ts";
import {
  ActorSection,
  DeprecationSection,
  DomainSection,
  FooterPointers,
  Identity,
  PromotedList,
  SessionContextLine,
} from "../../../src/pr-state/help/components.ts";

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

describe("Identity", () => {
  test("default title is `prx`", () => {
    expect(Identity()).toBe("prx\n==========");
  });

  test("custom subtitle underlines its own length", () => {
    const out = Identity("prx — full command catalog");
    expect(out.split("\n")[0]).toBe("prx — full command catalog");
    // Underline length matches subtitle character count.
    expect(out.split("\n")[1]!.length).toBe("prx — full command catalog".length);
  });
});

describe("SessionContextLine", () => {
  test("returns the canonical identity sentence", () => {
    expect(SessionContextLine("mainx")).toContain("GH-NNN");
    expect(SessionContextLine("mainx")).toContain("canonical");
  });
});

describe("PromotedList", () => {
  test("renders aligned name + description rows", () => {
    const out = PromotedList([
      spec({ name: "tui", description: "Interactive board and session UI" }),
      spec({
        name: "plan session",
        description: "Open plan-mode work session for a unit",
      }),
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    // Both rows align: the description column starts at the same offset.
    const col1 = lines[0]!.indexOf("Interactive");
    const col2 = lines[1]!.indexOf("Open");
    expect(col1).toBe(col2);
    expect(lines[0]!).toMatch(/^ {2}prx tui {2,}/);
    expect(lines[1]!).toMatch(/^ {2}prx plan session {2,}/);
  });

  test("empty input yields a placeholder line", () => {
    expect(PromotedList([])).toBe("  (no promoted commands)");
  });
});

describe("DomainSection", () => {
  test("emits header + aligned rows", () => {
    const out = DomainSection("State", [
      spec({ name: "model show", description: "Print machine model summary" }),
      spec({ name: "chain status", description: "Show parity chain status across repos" }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]!).toBe("State:");
    expect(lines[1]!).toMatch(/^ {2}prx model show {2,}Print/);
    expect(lines[2]).toMatch(/^ {2}prx chain status {2,}Show/);
  });

  test("empty domain section still renders header", () => {
    expect(DomainSection("System", [])).toBe("System:\n  (none)");
  });
});

describe("DeprecationSection", () => {
  test("renders alias_for + removal_target per row", () => {
    const out = DeprecationSection([
      spec({
        name: "session open",
        description: "Deprecated alias for plan session",
        deprecation: {
          alias_for: "plan session",
          removal_target: "#582 / #833",
          stderr_hint: "use plan session",
        },
      }),
    ]);
    expect(out).toContain("Deprecated spellings:");
    expect(out).toContain("prx session open");
    expect(out).toContain("alias for `prx plan session`");
    expect(out).toContain("removal: #582 / #833");
  });

  test("empty deprecations show explicit `(none)`", () => {
    expect(DeprecationSection([])).toBe("Deprecated spellings:\n  (none)");
  });
});

describe("ActorSection (GH-1311)", () => {
  test("partitions specs into Lifecycle / Toolset / Preflight subsections", () => {
    const out = ActorSection("Subcommands", [
      spec({
        name: "plan session",
        description: "Open plan-mode work session for a unit",
        session_role: "lifecycle",
      }),
      spec({
        name: "plan view",
        description: "View an issue (GH/bd id, URL)",
        session_role: "toolset",
      }),
      spec({
        name: "plan ci",
        description: "Run canonical pre-push validation locally",
        session_role: "preflight",
      }),
    ]);
    expect(out).toMatch(/^Subcommands:/);
    const lifecycleIdx = out.indexOf("Lifecycle:");
    const toolsetIdx = out.indexOf("Toolset:");
    const preflightIdx = out.indexOf("Preflight:");
    expect(lifecycleIdx).toBeGreaterThan(0);
    expect(toolsetIdx).toBeGreaterThan(lifecycleIdx);
    expect(preflightIdx).toBeGreaterThan(toolsetIdx);
    expect(out).toContain("prx plan session");
    expect(out).toContain("prx plan view");
    expect(out).toContain("prx plan ci");
  });

  test("omits a subsection when its bucket is empty", () => {
    const out = ActorSection("Subcommands", [
      spec({
        name: "plan session",
        description: "Open plan-mode work session for a unit",
        session_role: "lifecycle",
      }),
    ]);
    expect(out).toContain("Lifecycle:");
    expect(out).not.toContain("Toolset:");
    expect(out).not.toContain("Preflight:");
  });

  test("untagged specs land under a trailing Other bucket", () => {
    const out = ActorSection("Subcommands", [
      spec({
        name: "plan session",
        description: "Open plan-mode work session for a unit",
        session_role: "lifecycle",
      }),
      spec({ name: "plan stray", description: "Not yet tagged with a role" }),
    ]);
    expect(out).toContain("Lifecycle:");
    expect(out).toContain("Other:");
    const lifecycleIdx = out.indexOf("Lifecycle:");
    const otherIdx = out.indexOf("Other:");
    expect(otherIdx).toBeGreaterThan(lifecycleIdx);
  });

  test("empty input yields header + (none) placeholder", () => {
    expect(ActorSection("Subcommands", [])).toBe("Subcommands:\n  (none)");
  });
});

describe("FooterPointers", () => {
  test("overview footer points at help-all + per-command help", () => {
    const out = FooterPointers("overview");
    expect(out).toContain("prx help-all");
    expect(out).toContain("prx <cmd> --help");
  });

  test("help-all footer covers common flow + identity", () => {
    const out = FooterPointers("help-all");
    expect(out).toContain("Common flow:");
    expect(out).toContain("Work-unit identity:");
    // The interactive `prx tui` surface was removed (prx-fdf).
    expect(out).not.toContain("prx tui");
  });
});
