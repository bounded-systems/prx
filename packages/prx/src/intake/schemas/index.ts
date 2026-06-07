/**
 * Per-intake-type body schemas (GH-1258).
 *
 * Two surfaces share these schemas:
 *
 *   1. **JSON Schema artifact** (`schemas/intake/<type>.json`) — derived
 *      from `INTAKE_BODY_SCHEMAS` via `prx schemas`.
 *      Documents the full target shape per type for downstream consumers
 *      (scout JSONL, audit instruments, future tooling).
 *
 *   2. **Runtime validation** — `validateIntakeBody` adapts today's CLI
 *      structured-field flags (`--description / --design / --acceptance /
 *      --notes`) to the canonical snake_case schema field names, runs
 *      `safeParse`, and maps issues back to CLI-shaped paths.
 *
 * The schema is the contract. Bug/task/feature/chore enforce required
 * fields at runtime today; spike enforcement is deferred (the schema
 * ships as artifact-only) until spike-shaped CLI flags exist (depends
 * on GH-1248 vocab). `epic` is not in `INTAKE_TYPES` — its schema ships
 * as an artifact only and is never reached at runtime.
 */

import type { z } from "zod";

import { bugBodySchema } from "./bug.ts";
import { choreBodySchema } from "./chore.ts";
import { epicBodySchema } from "./epic.ts";
import { featureBodySchema } from "./feature.ts";
import { spikeBodySchema } from "./spike.ts";
import { taskBodySchema } from "./task.ts";

export type { IntakeFieldMeta, IntakeFieldsMeta } from "./meta.ts";
export { parseStructuredBody, type ParsedStructuredBody } from "./parse.ts";
export {
  INTAKE_BODY_FIELDS_META,
  INTAKE_BODY_SCHEMA_TYPES,
  type IntakeBodySchemaType,
} from "./fields_meta.ts";

import type { IntakeBodySchemaType } from "./fields_meta.ts";

export const INTAKE_BODY_SCHEMAS: Record<IntakeBodySchemaType, z.ZodTypeAny> = {
  bug: bugBodySchema,
  task: taskBodySchema,
  feature: featureBodySchema,
  chore: choreBodySchema,
  spike: spikeBodySchema,
  epic: epicBodySchema,
};

/**
 * Today's CLI structured-field surface. `acceptance` is the operator-
 * facing flag; the canonical schema name is `acceptance_criteria`.
 */
export type IntakeCliFields = {
  description?: string | undefined;
  design?: string | undefined;
  acceptance?: string | undefined;
  notes?: string | undefined;
};

/**
 * One CLI-flag-name -> canonical-schema-field-name pair. The reverse
 * map is the same shape, used to translate Zod issue paths back to the
 * operator-visible flag.
 */
const CLI_TO_CANONICAL: Record<keyof IntakeCliFields, string> = {
  description: "description",
  design: "design",
  acceptance: "acceptance_criteria",
  notes: "notes",
};

const CANONICAL_TO_CLI: Record<string, keyof IntakeCliFields> = {
  description: "description",
  design: "design",
  acceptance_criteria: "acceptance",
  notes: "notes",
};

/**
 * Types whose CLI flags map cleanly to canonical schema fields and
 * which therefore enforce required-field validation at intake time.
 * Spike's canonical fields (question, proposed_approach, ...) do not
 * have CLI flags yet; runtime enforcement is deferred until they do.
 */
const ENFORCED_TYPES: ReadonlySet<IntakeBodySchemaType> = new Set([
  "bug",
  "task",
  "feature",
  "chore",
]);

export type IntakeBodyIssue = {
  /** CLI-shaped field name (`description`, `acceptance`, ...). */
  path: keyof IntakeCliFields;
  message: string;
};

export type ValidateIntakeBodyResult =
  | { ok: true }
  | { ok: false; issues: IntakeBodyIssue[] };

/**
 * Validate the structured-field cluster of a `prx intake` invocation
 * against the per-type schema. Returns CLI-shaped issue paths so the
 * intake-options `superRefine` can attach them to the right operator
 * flag.
 *
 * Spike returns ok eagerly today (deferred enforcement). Epic is not
 * a runtime intake type and the function rejects it defensively.
 */
export function validateIntakeBody(
  type: IntakeBodySchemaType,
  cliFields: IntakeCliFields,
): ValidateIntakeBodyResult {
  if (!ENFORCED_TYPES.has(type)) {
    return { ok: true };
  }

  const schema = INTAKE_BODY_SCHEMAS[type];
  const canonicalInput: Record<string, string> = {};
  for (const [cliKey, canonicalKey] of Object.entries(CLI_TO_CANONICAL) as Array<
    [keyof IntakeCliFields, string]
  >) {
    const value = cliFields[cliKey];
    if (value !== undefined && value.length > 0) {
      canonicalInput[canonicalKey] = value;
    }
  }

  const result = schema.safeParse(canonicalInput);
  if (result.success) return { ok: true };

  const issues: IntakeBodyIssue[] = [];
  for (const issue of result.error.issues) {
    const head = issue.path[0];
    if (typeof head !== "string") continue;
    const cliKey = CANONICAL_TO_CLI[head];
    if (!cliKey) continue;
    issues.push({ path: cliKey, message: `${cliKey}: required` });
  }
  return { ok: false, issues };
}
