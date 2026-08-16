/**
 * JSON Schema artifact builder (GH-1359).
 *
 * Wraps `toJsonSchemaArtifact` and decorates each property with the canonical
 * heading + `actionsBearing` classification from `INTAKE_BODY_FIELDS_META`.
 * Vendor extensions (`x-prx-*`) keep the artifact valid Draft-7.
 *
 * Both `prx schemas` and the parity test in
 * `test/intake/schemas.test.ts` import from here so they cannot drift.
 */

import { toJsonSchemaArtifact } from "../../lib/json-schema.ts";

import {
  INTAKE_BODY_FIELDS_META,
  INTAKE_BODY_SCHEMAS,
  type IntakeBodySchemaType,
} from "./index.ts";

export function buildIntakeJsonSchema(type: IntakeBodySchemaType): unknown {
  const json = toJsonSchemaArtifact(INTAKE_BODY_SCHEMAS[type], `intake_${type}_body`);
  return decorateWithFieldsMeta(json, type);
}

function decorateWithFieldsMeta(
  schemaJson: Record<string, unknown>,
  type: IntakeBodySchemaType,
): Record<string, unknown> {
  const meta = INTAKE_BODY_FIELDS_META[type];
  const definitions = schemaJson.definitions as Record<string, unknown> | undefined;
  if (!definitions) return schemaJson;
  const def = definitions[`intake_${type}_body`] as Record<string, unknown> | undefined;
  if (!def || def.type !== "object") return schemaJson;
  const properties = def.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return schemaJson;
  for (const [field, fieldMeta] of Object.entries(meta)) {
    const prop = properties[field];
    if (!prop) continue;
    prop["x-prx-actions-bearing"] = fieldMeta.actionsBearing;
    prop["x-prx-heading"] = fieldMeta.heading;
  }
  return schemaJson;
}
