// GH-1238: parsePlanScope is the §-Scope locator behind the implement-session
// refusal contract. Tests cover the full set of refusal-relevant shapes:
// no Scope heading at all, Scope with only whitespace/comments, and Scope
// with real content that the implement session should auto-prime from.

import { describe, expect, test } from "bun:test";

import { parsePlanScope, validatePlanShape } from "../../src/plan-store/scope.ts";

describe("parsePlanScope (GH-1238)", () => {
  test("returns hasScope=false when no `## Scope` heading exists", () => {
    const body = "# Plan\n\n## Goals\n\nDo a thing.\n";
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(false);
    expect(result.scopeBody).toBe("");
    expect(result.isEmpty).toBe(true);
  });

  test("captures scope body between `## Scope` and the next same-depth heading", () => {
    const body = [
      "# Plan GH-1238",
      "",
      "## Context",
      "",
      "Background.",
      "",
      "## Scope",
      "",
      "- Tighten implement allowlist.",
      "- Auto-prime from draft slot.",
      "",
      "## Out of scope",
      "- Other things.",
      "",
    ].join("\n");
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.scopeBody).toContain("Tighten implement allowlist");
    expect(result.scopeBody).toContain("Auto-prime from draft slot");
    expect(result.scopeBody).not.toContain("Out of scope");
    expect(result.scopeBody).not.toContain("Background");
  });

  test("captures scope body between `### Scope` and the next same-or-shallower heading", () => {
    const body = [
      "# Plan",
      "",
      "## Plan",
      "",
      "### Scope",
      "",
      "Real content.",
      "",
      "### Out of scope",
      "Other.",
      "## Acceptance",
      "Done.",
    ].join("\n");
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.scopeBody).toBe("Real content.");
  });

  test("captures scope body to end of file when no later heading exists", () => {
    const body = ["# Plan", "", "## Scope", "", "Final paragraph.", ""].join("\n");
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.scopeBody).toBe("Final paragraph.");
  });

  test("isEmpty=true when scope contains only whitespace", () => {
    const body = "## Scope\n\n   \n\n## Next\n";
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.isEmpty).toBe(true);
  });

  test("isEmpty=true when scope contains only HTML comments", () => {
    const body = [
      "## Scope",
      "",
      "<!-- TODO: fill me in -->",
      "<!-- another note -->",
      "",
      "## Next",
    ].join("\n");
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.isEmpty).toBe(true);
  });

  test("scope heading is case-insensitive on the word `Scope`", () => {
    const body = "## scope\n\nlowercase.\n";
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    expect(result.scopeBody).toBe("lowercase.");
  });

  test("only the first matching Scope heading is used", () => {
    const body = ["## Scope", "first.", "## Other", "## Scope", "second."].join("\n");
    const result = parsePlanScope(body);
    expect(result.hasScope).toBe(true);
    // The capture stops at `## Other` (same depth), so only "first." is kept.
    expect(result.scopeBody).toBe("first.");
  });

  test("accepts a Buffer as input", () => {
    const result = parsePlanScope(Buffer.from("## Scope\n\nbuffered.\n"));
    expect(result.hasScope).toBe(true);
    expect(result.scopeBody).toBe("buffered.");
  });
});

// GH-1277 → GH-2028: validatePlanShape is the single source of truth for the
// content-validation verdict. Under persist-on-failure it produces a verdict
// (validated_ok + diagnostics) rather than refusing; the producer records it in
// the envelope and the consumer (`prx implement agent`) refuses on
// validated_ok=false. The `{code,path,message}` diagnostic shape is reused so
// GH-1252 can later adopt it wholesale.
describe("validatePlanShape (GH-2028)", () => {
  test("validated_ok=true on a body with a non-empty `## Scope` section", () => {
    const body = "# Plan\n\n## Scope\n\nReal scope.\n";
    expect(validatePlanShape(body, "GH-1277")).toEqual({
      validated_ok: true,
      diagnostics: [],
    });
  });

  test("validated_ok=false code=no-scope when no `## Scope` heading exists", () => {
    const body = "# Plan\n\n## Goals\n\nDo a thing.\n";
    const result = validatePlanShape(body, "GH-1277");
    expect(result.validated_ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d.code).toBe("no-scope");
    expect(d.path).toBe("## Scope");
    expect(d.message).toContain("GH-1277");
    expect(d.message).toContain("no `## Scope`");
    expect(d.message).toContain("Refine via `prx plan session GH-1277`");
  });

  test("validated_ok=false code=empty-scope when scope is whitespace + HTML comments only", () => {
    const body = "## Scope\n\n<!-- TODO: fill me in -->\n\n## Next\n";
    const result = validatePlanShape(body, "GH-1277");
    expect(result.validated_ok).toBe(false);
    const d = result.diagnostics[0]!;
    expect(d.code).toBe("empty-scope");
    expect(d.path).toBe("## Scope");
    expect(d.message).toContain("GH-1277");
    expect(d.message).toContain("empty `## Scope`");
    expect(d.message).toContain("Refine via `prx plan session GH-1277`");
  });

  test("accepts a Buffer body and threads the unit id into the diagnostic text", () => {
    const result = validatePlanShape(Buffer.from("# Nothing here\n"), "GH-9999");
    expect(result.validated_ok).toBe(false);
    expect(result.diagnostics[0]!.message).toContain("GH-9999");
  });
});
