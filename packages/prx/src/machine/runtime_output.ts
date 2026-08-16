import { toolActors } from "./actors.ts";
import { workflowPhases } from "@bounded-systems/machine-schema";
import { canonicalWorkUnitIdPattern } from "./work_unit.ts";
import { taskAgentRoles } from "./runtime_profiles.ts";

export const runtimeStatusValues = ["analysis", "planned", "implemented", "blocked"] as const;
export const verificationStatusValues = ["not_run", "passed", "failed"] as const;
export const runtimeRequiredFields = [
  "workUnitId",
  "role",
  "phase",
  "status",
  "parityChain",
  "modelBoundary",
  "implementationPlan",
  "changes",
  "verification",
] as const;

export function buildRuntimeOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      workUnitId: {
        type: "string",
        pattern: canonicalWorkUnitIdPattern.source,
      },
      role: {
        type: "string",
        enum: [...taskAgentRoles],
      },
      phase: {
        type: "string",
        enum: [...workflowPhases],
      },
      status: {
        type: "string",
        enum: [...runtimeStatusValues],
      },
      summary: {
        type: "string",
      },
      parityChain: {
        type: "object",
        properties: {
          authority: {
            type: "string",
            enum: ["issue", "pr"],
          },
          branch: {
            type: "string",
          },
          worktree: {
            type: "string",
          },
          pr: {
            type: ["integer", "null"],
          },
        },
        additionalProperties: true,
      },
      modelBoundary: {
        type: "object",
        properties: {
          workflowStates: {
            type: "array",
            items: { type: "string" },
          },
          actors: {
            type: "array",
            items: {
              type: "string",
              enum: [...toolActors],
            },
          },
          events: {
            type: "array",
            items: { type: "string" },
          },
          schemaBoundaries: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: true,
      },
      implementationPlan: {
        type: "array",
        items: { type: "string" },
      },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            summary: { type: "string" },
          },
          required: ["path", "summary"],
          additionalProperties: false,
        },
      },
      verification: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...verificationStatusValues],
          },
          testsRan: {
            type: "array",
            items: { type: "string" },
          },
          testsNotRun: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: true,
      },
      blockers: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [...runtimeRequiredFields],
    additionalProperties: true,
  };
}
