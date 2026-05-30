/**
 * Aggregated per-intake-type field metadata (GH-1359).
 *
 * Lives in its own module so `parseStructuredBody` and `index.ts` can
 * both depend on it without the indirect import cycle that would arise
 * from `parse.ts` reaching back through the package barrel.
 */
import { bugBodyFieldsMeta } from "./bug.ts";
import { choreBodyFieldsMeta } from "./chore.ts";
import { epicBodyFieldsMeta } from "./epic.ts";
import { featureBodyFieldsMeta } from "./feature.ts";
import type { IntakeFieldsMeta } from "./meta.ts";
import { spikeBodyFieldsMeta } from "./spike.ts";
import { taskBodyFieldsMeta } from "./task.ts";

export const INTAKE_BODY_SCHEMA_TYPES = [
  "bug",
  "task",
  "feature",
  "chore",
  "spike",
  "epic",
] as const;
export type IntakeBodySchemaType = (typeof INTAKE_BODY_SCHEMA_TYPES)[number];

export const INTAKE_BODY_FIELDS_META: Record<IntakeBodySchemaType, IntakeFieldsMeta> = {
  bug: bugBodyFieldsMeta,
  task: taskBodyFieldsMeta,
  feature: featureBodyFieldsMeta,
  chore: choreBodyFieldsMeta,
  spike: spikeBodyFieldsMeta,
  epic: epicBodyFieldsMeta,
};
