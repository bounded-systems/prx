// ai-home-r5crv (epic ai-home-tbs4f): the plan artifact is a typed object, not
// free-text. These tests lock the two invariants the submit_plan tool relies
// on: (1) the schema rejects a plan with no real scope, and (2) the renderer's
// markdown always satisfies `validatePlanShape` — so the post-hoc Scope gate
// (plan-store/scope.ts) becomes a redundant safety net rather than the primary
// enforcement point.

import { describe, expect, test } from "bun:test";

import {
  PlanArtifactSchema,
  renderPlanArtifact,
  planArtifactJsonSchema,
  validatePlanArtifactJson,
  validatePlanBody,
  detectPlanBodyFormat,
  type PlanArtifact,
} from "../../src/plan-store/plan-artifact.ts";
import { validatePlanShape } from "../../src/plan-store/scope.ts";

const valid: PlanArtifact = {
  problem: "The draft slot captures free-text instead of a structured plan.",
  scope: "Add a submit_plan tool that captures a typed PlanArtifact.",
  approach: "Register an in-process SDK tool; render its input to markdown.",
  changes: ["src/plan-store/plan-artifact.ts", "src/claude/agent_service.ts"],
  paths: ["src/plan-store/plan-artifact.ts", "src/claude/agent_service.ts"],
  risks: ["plan permission mode may block the custom tool"],
  acceptance: ["draft slot lands with validated_ok=true"],
  decision: "proceed",
};

describe("PlanArtifactSchema (ai-home-r5crv)", () => {
  test("accepts a fully-populated plan", () => {
    const parsed = PlanArtifactSchema.parse(valid);
    expect(parsed.scope).toBe(valid.scope);
  });

  test("rejects a missing scope", () => {
    const { scope, ...rest } = valid;
    expect(() => PlanArtifactSchema.parse(rest)).toThrow();
  });

  test("rejects an empty / whitespace-only scope", () => {
    expect(() => PlanArtifactSchema.parse({ ...valid, scope: "" })).toThrow();
    expect(() => PlanArtifactSchema.parse({ ...valid, scope: "   " })).toThrow();
  });

  test("rejects a missing acceptance list", () => {
    const { acceptance, ...rest } = valid;
    expect(() => PlanArtifactSchema.parse(rest)).toThrow();
  });

  test("defaults the optional list fields to empty arrays", () => {
    const parsed = PlanArtifactSchema.parse({
      problem: "p",
      scope: "s",
      approach: "a",
      acceptance: ["done"],
    });
    expect(parsed.changes).toEqual([]);
    expect(parsed.risks).toEqual([]);
    // prx-tth: the scope-gate allowlist defaults empty (⇒ fail-closed).
    expect(parsed.paths).toEqual([]);
  });

  test("prx-tth: the structured `paths` allowlist round-trips", () => {
    const parsed = PlanArtifactSchema.parse(valid);
    expect(parsed.paths).toEqual(valid.paths);
  });
});

describe("renderPlanArtifact (ai-home-r5crv)", () => {
  test("emits a `## Scope` section that validatePlanShape accepts", () => {
    const md = renderPlanArtifact(valid);
    expect(md).toContain("## Scope");
    const verdict = validatePlanShape(md, "GH-2316");
    expect(verdict.validated_ok).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
  });

  test("renders every section heading in canonical order", () => {
    const md = renderPlanArtifact(valid);
    const order = ["## Problem", "## Scope", "## Approach", "## Changes", "## Paths", "## Risks", "## Acceptance"];
    let last = -1;
    for (const h of order) {
      const at = md.indexOf(h);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test("renders list fields as markdown bullets", () => {
    const md = renderPlanArtifact(valid);
    expect(md).toContain("- src/plan-store/plan-artifact.ts");
    expect(md).toContain("- draft slot lands with validated_ok=true");
  });

  test("a minimal plan (empty optional lists) still passes the Scope gate", () => {
    const minimal = PlanArtifactSchema.parse({
      problem: "p",
      scope: "s",
      approach: "a",
      acceptance: ["done"],
    });
    const md = renderPlanArtifact(minimal);
    expect(validatePlanShape(md, "GH-1").validated_ok).toBe(true);
  });
});

// GH-1480: the canonical serialized plan body is a JSON PlanArtifact; markdown
// is a rendered projection. These lock the JSON schema export, the JSON-body
// validator, and the format dispatcher.

describe("planArtifactJsonSchema (GH-1480)", () => {
  test("is derived from the Zod schema and names every field", () => {
    const json = JSON.stringify(planArtifactJsonSchema);
    for (const field of ["problem", "scope", "approach", "changes", "risks", "acceptance"]) {
      expect(json).toContain(field);
    }
  });
});

describe("detectPlanBodyFormat (GH-1480)", () => {
  test("classifies an object-literal body as json", () => {
    expect(detectPlanBodyFormat(JSON.stringify(valid))).toBe("json");
    expect(detectPlanBodyFormat("  \n  {}")).toBe("json");
  });
  test("classifies markdown as markdown", () => {
    expect(detectPlanBodyFormat("## Scope\n\nx")).toBe("markdown");
    expect(detectPlanBodyFormat("# Plan")).toBe("markdown");
  });
});

describe("validatePlanArtifactJson (GH-1480)", () => {
  test("accepts a valid artifact", () => {
    const verdict = validatePlanArtifactJson(JSON.stringify(valid));
    expect(verdict.validated_ok).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
  });

  test("a missing scope yields the no-scope diagnostic class", () => {
    const verdict = validatePlanArtifactJson(
      JSON.stringify({ problem: "p", approach: "a", acceptance: ["done"] }),
    );
    expect(verdict.validated_ok).toBe(false);
    expect(verdict.diagnostics.some((d) => d.code === "no-scope")).toBe(true);
  });

  test("an empty scope yields the empty-scope diagnostic class", () => {
    const verdict = validatePlanArtifactJson(JSON.stringify({ ...valid, scope: "" }));
    expect(verdict.validated_ok).toBe(false);
    expect(verdict.diagnostics.some((d) => d.code === "empty-scope")).toBe(true);
  });

  test("unparseable input yields invalid-json", () => {
    const verdict = validatePlanArtifactJson("{ not json");
    expect(verdict.validated_ok).toBe(false);
    expect(verdict.diagnostics[0]!.code).toBe("invalid-json");
  });

  test("other schema failures yield schema-invalid", () => {
    const verdict = validatePlanArtifactJson(
      JSON.stringify({ problem: "p", scope: "s", approach: "a", acceptance: [] }),
    );
    expect(verdict.validated_ok).toBe(false);
    expect(verdict.diagnostics.some((d) => d.code === "schema-invalid")).toBe(true);
  });
});

describe("validatePlanBody dispatch (GH-1480)", () => {
  test("routes JSON bodies to the artifact validator", () => {
    expect(validatePlanBody(JSON.stringify(valid), "GH-1").validated_ok).toBe(true);
    expect(validatePlanBody("{ bad", "GH-1").validated_ok).toBe(false);
  });

  test("routes markdown bodies to the shape gate", () => {
    expect(validatePlanBody("## Scope\n\nthe boundary\n", "GH-1").validated_ok).toBe(true);
    expect(validatePlanBody("no scope heading", "GH-1").validated_ok).toBe(false);
  });
});
