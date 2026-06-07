// Every JSON-Schema artifact prx commits, in one place — extracted from the
// export-*-schema scripts so the `prx schemas` verb and the scripts render the
// SAME bytes. Each entry is { path, content } where content is exactly what the
// scripts write: `JSON.stringify(artifact, null, 2) + "\n"`.
//
// Path resolution is LAZY (getRepoRoot inside the function) — never at import —
// so this is safe to pull into any graph; the verb dynamic-imports it so the
// schema source modules don't load at CLI startup.

import { resolve } from "node:path";

import { getRepoRoot } from "@bounded-systems/repo-root";

import { toJsonSchemaArtifact } from "../lib/json-schema.ts";
import {
  artifactSlotSchema,
  artifactStatusSchema,
  artifactTypeSchema,
} from "../audit/artifact-types.ts";
import {
  agentContractSchema,
  artifactContractSchema,
  transitionContractSchema,
} from "../machine/contracts.ts";
import {
  blockerReportSchema,
  delegationRecordSchema,
  sprintPlanSchema,
  statusUpdateSchema,
} from "../machine/contracts/lifecycle_artifacts.ts";
import { factRelations, factSchemas } from "../derive/schemas/relations.ts";
import { PROJECT_GRAPH_SCHEMA_NAME, ProjectGraph } from "../graph/model.ts";
import { CODE_HEALTH_SCHEMA_NAME, CodeHealthReport } from "../health/model.ts";
import { buildIntakeJsonSchema } from "../intake/schemas/export_json.ts";
import { INTAKE_BODY_SCHEMA_TYPES } from "../intake/schemas/index.ts";
import { README_MODEL_SCHEMA_NAME, ReadmeModel } from "../readme/model.ts";
import { scoutNotionResultSchema } from "../scout/notion.ts";
import {
  WORKSPACE_INPUT_SCHEMAS,
  WORKSPACE_OUTPUT_SCHEMAS,
  WORKSPACE_VERBS,
} from "../workspace/schema.ts";

/** One committed JSON-Schema artifact: repo-relative path + exact file content. */
export type SchemaArtifact = { path: string; content: string };

const ser = (json: unknown): string => JSON.stringify(json, null, 2) + "\n";

/** Every JSON-Schema artifact, freshly rendered from its Zod source. */
export function schemaArtifacts(): SchemaArtifact[] {
  // The committed artifacts live under the PACKAGE root (packages/prx/schemas/),
  // not the git root — matching the export-* scripts' `resolve(here, "..")`.
  const pkgRoot = resolve(getRepoRoot(), "packages/prx");
  const at = (rel: string, content: string): SchemaArtifact => ({ path: resolve(pkgRoot, rel), content });
  const out: SchemaArtifact[] = [];

  // audit — src/audit/artifact-types.ts
  for (const { name, schema } of [
    { name: "artifact-type", schema: artifactTypeSchema },
    { name: "artifact-status", schema: artifactStatusSchema },
    { name: "artifact-slot", schema: artifactSlotSchema },
  ] as const) {
    out.push(at(`schemas/audit/${name}.json`, ser(toJsonSchemaArtifact(schema, `audit_${name.replace(/-/g, "_")}`))));
  }

  // contracts — the trinity + the lifecycle axis
  for (const { file, schema, name } of [
    { file: "agent", schema: agentContractSchema, name: "agent_contract" },
    { file: "artifact", schema: artifactContractSchema, name: "artifact_contract" },
    { file: "transition", schema: transitionContractSchema, name: "transition_contract" },
  ] as const) {
    out.push(at(`schemas/contracts/${file}.json`, ser(toJsonSchemaArtifact(schema, name))));
  }
  for (const { file, schema, name } of [
    { file: "status-update", schema: statusUpdateSchema, name: "status_update" },
    { file: "blocker-report", schema: blockerReportSchema, name: "blocker_report" },
    { file: "delegation-record", schema: delegationRecordSchema, name: "delegation_record" },
    { file: "sprint-plan", schema: sprintPlanSchema, name: "sprint_plan" },
  ] as const) {
    out.push(at(`schemas/contracts/lifecycle/${file}.json`, ser(toJsonSchemaArtifact(schema, name))));
  }

  // derive — one per fact relation
  for (const name of factRelations) {
    out.push(at(`schemas/derive/${name}.json`, ser(toJsonSchemaArtifact(factSchemas[name], `derive_${name}`))));
  }

  // graph / health / readme — single schemas
  out.push(at("schemas/graph/project-graph.schema.json", ser(toJsonSchemaArtifact(ProjectGraph, PROJECT_GRAPH_SCHEMA_NAME))));
  out.push(at("schemas/health/health.schema.json", ser(toJsonSchemaArtifact(CodeHealthReport, CODE_HEALTH_SCHEMA_NAME))));
  out.push(at("schemas/readme/readme.schema.json", ser(toJsonSchemaArtifact(ReadmeModel, README_MODEL_SCHEMA_NAME))));

  // intake — one per body type (its own JSON-Schema builder, not toJsonSchemaArtifact)
  for (const type of INTAKE_BODY_SCHEMA_TYPES) {
    out.push(at(`schemas/intake/${type}.json`, ser(buildIntakeJsonSchema(type))));
  }

  // scout
  out.push(at("schemas/scout/notion.json", ser(toJsonSchemaArtifact(scoutNotionResultSchema, "scout_notion_result"))));

  // workspace — input + output per verb
  for (const verb of WORKSPACE_VERBS) {
    out.push(at(`schemas/workspace/${verb}.input.json`, ser(toJsonSchemaArtifact(WORKSPACE_INPUT_SCHEMAS[verb], `workspace_${verb}_input`))));
    out.push(at(`schemas/workspace/${verb}.output.json`, ser(toJsonSchemaArtifact(WORKSPACE_OUTPUT_SCHEMAS[verb], `workspace_${verb}_output`))));
  }

  return out;
}
