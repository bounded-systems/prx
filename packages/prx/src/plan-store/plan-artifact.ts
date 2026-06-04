// ai-home-r5crv (epic ai-home-tbs4f): the plan artifact as a typed object.
//
// `prx plan session` used to capture the planner's raw free-text stdout as the
// plan body, then regex-check it for a `## Scope` heading after the fact
// (plan-store/scope.ts) — a detector, not a constraint, so a prose summary
// routinely slipped through as validated_ok=false. This module makes the plan
// a schema: the `submit_plan` SDK tool (src/claude/agent_service.ts) takes
// `PlanArtifactShape` as its input schema, so the model cannot submit a plan
// without a non-empty scope, and `renderPlanArtifact` deterministically emits
// markdown that always satisfies `validatePlanShape`.
//
// Pure module — no IO. The field vocabulary mirrors the existing plan-print
// prompt (runtime_profiles.ts buildWorkUnitClaudePlanPrintRuntimeProfile):
// "problem statement, scope boundary, proposed approach, file-level change
// list, risks, and acceptance criteria".

import { z } from "zod";
import { toJsonSchemaArtifact } from "../lib/json-schema.ts";
import { validatePlanShape, type PlanShapeVerdict } from "./scope.ts";
import type { PlanDiagnostic } from "./envelope.ts";

const nonEmpty = z.string().trim().min(1);

// AnyZodRawShape (not a z.object) so it can be handed straight to the Agent
// SDK's `tool(name, desc, inputSchema, handler)`, which expects a raw shape.
export const PlanArtifactShape = {
  problem: nonEmpty.describe("Problem statement: what is broken or missing and why it matters."),
  scope: nonEmpty.describe("Scope boundary: exactly what this work changes (and implicitly, what it does not)."),
  approach: nonEmpty.describe("Proposed approach: how the change is made."),
  changes: z
    .array(nonEmpty)
    .default([])
    .describe("File-level change list: paths touched and the nature of each change."),
  risks: z
    .array(nonEmpty)
    .default([])
    .describe("Risks, unknowns, or `[NEEDS CLARIFICATION]` markers."),
  acceptance: z
    .array(nonEmpty)
    .min(1)
    .describe("Acceptance criteria: observable conditions that confirm the work is done."),
} as const;

export const PlanArtifactSchema = z.object(PlanArtifactShape);

export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

function renderList(items: readonly string[]): string {
  if (items.length === 0) return "_None._";
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Deterministically render a {@link PlanArtifact} to the canonical markdown the
 * draft slot stores. The `## Scope` section is always present and non-empty, so
 * the rendered output unconditionally passes {@link validatePlanShape} — the
 * shape gate downstream is a belt-and-suspenders check, not the enforcement
 * point. Section order matches the prompt vocabulary so handoff to Ultraplan is
 * stable across runs.
 */
export function renderPlanArtifact(artifact: PlanArtifact): string {
  return [
    "## Problem",
    "",
    artifact.problem,
    "",
    "## Scope",
    "",
    artifact.scope,
    "",
    "## Approach",
    "",
    artifact.approach,
    "",
    "## Changes",
    "",
    renderList(artifact.changes),
    "",
    "## Risks",
    "",
    renderList(artifact.risks),
    "",
    "## Acceptance",
    "",
    renderList(artifact.acceptance),
    "",
  ].join("\n");
}

// GH-1480 / GH-313: the canonical serialized form of a plan is a JSON
// PlanArtifact; markdown is a rendered projection of it. The pieces below give
// that JSON form a discoverable schema, a schema validator, and a format
// detector so `prx plan validate` / `prx plan schema` can surface the contract.

/**
 * JSON Schema derived from {@link PlanArtifactSchema} — the discoverable
 * body-shape contract printed by `prx plan schema`. Derived (not hand-authored)
 * so it cannot drift from the Zod schema.
 */
export const planArtifactJsonSchema: Record<string, unknown> =
  toJsonSchemaArtifact(PlanArtifactSchema, "PlanArtifact");

/**
 * Classify a plan body by serialized form: a body that begins with an object
 * literal is the canonical JSON artifact; anything else is legacy markdown.
 */
export function detectPlanBodyFormat(body: string): "json" | "markdown" {
  return body.trimStart().startsWith("{") ? "json" : "markdown";
}

/**
 * Validate a structured JSON PlanArtifact body against {@link PlanArtifactSchema}.
 *
 * Returns the same {@link PlanShapeVerdict} the markdown gate uses. A missing or
 * empty `scope` maps to the `no-scope` / `empty-scope` diagnostic codes so the
 * contract reads the same regardless of body format; other schema failures use
 * `schema-invalid`, and unparseable input uses `invalid-json`.
 */
export function validatePlanArtifactJson(body: string): PlanShapeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      validated_ok: false,
      diagnostics: [
        {
          code: "invalid-json",
          path: "",
          message: `plan body is not valid JSON: ${(err as Error).message}`,
        },
      ],
    };
  }
  const result = PlanArtifactSchema.safeParse(parsed);
  if (result.success) {
    return { validated_ok: true, diagnostics: [] };
  }
  const diagnostics: PlanDiagnostic[] = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    if (path === "scope") {
      return issue.code === "too_small"
        ? { code: "empty-scope", path, message: "plan artifact `scope` is empty" }
        : { code: "no-scope", path, message: "plan artifact is missing a `scope` field" };
    }
    return { code: "schema-invalid", path: path || "(root)", message: issue.message };
  });
  return { validated_ok: false, diagnostics };
}

/**
 * Validate a plan body against the body-shape contract, dispatching on format:
 * canonical JSON bodies route to {@link validatePlanArtifactJson}; legacy
 * markdown routes to {@link validatePlanShape}.
 */
export function validatePlanBody(body: string, unitId: string): PlanShapeVerdict {
  return detectPlanBodyFormat(body) === "json"
    ? validatePlanArtifactJson(body)
    : validatePlanShape(body, unitId);
}
