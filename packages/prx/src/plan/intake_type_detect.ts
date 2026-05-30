/**
 * Detect the intake-body schema type for an issue (GH-1359).
 *
 * Priority:
 *   1. `type::*` label (canonical) — bug/task/feature/chore/spike/epic.
 *   2. Title-prefix conv-commit form (`feat:`, `fix:`, `bug:`, ...) via the
 *      shared `PREFIX_TO_INTAKE_INTENT` map.
 *
 * Returns `null` when neither signal yields a recognised type. The
 * `runPlanPreflight` caller treats `null` as the legacy whole-body scan
 * fallback.
 */

import { PREFIX_RE, PREFIX_TO_INTAKE_INTENT } from "../intake/types.ts";
import {
  INTAKE_BODY_SCHEMA_TYPES,
  type IntakeBodySchemaType,
} from "../intake/schemas/index.ts";

const SCHEMA_TYPE_SET = new Set<string>(INTAKE_BODY_SCHEMA_TYPES);

type LabelLike = string | { name?: string | null } | null | undefined;

function readLabelName(label: LabelLike): string | null {
  if (typeof label === "string") return label;
  if (label && typeof label === "object" && typeof label.name === "string") {
    return label.name;
  }
  return null;
}

export function detectIntakeTypeFromIssue(
  labels: readonly LabelLike[] | null | undefined,
  title: string | null | undefined,
): IntakeBodySchemaType | null {
  if (Array.isArray(labels)) {
    for (const label of labels) {
      const name = readLabelName(label);
      if (!name) continue;
      const lower = name.trim().toLowerCase();
      if (!lower.startsWith("type::")) continue;
      const candidate = lower.slice("type::".length);
      if (SCHEMA_TYPE_SET.has(candidate)) {
        return candidate as IntakeBodySchemaType;
      }
    }
  }
  if (typeof title === "string") {
    const match = title.match(PREFIX_RE);
    if (match) {
      const mapped = PREFIX_TO_INTAKE_INTENT[match[1]!];
      if (mapped && SCHEMA_TYPE_SET.has(mapped)) {
        return mapped as IntakeBodySchemaType;
      }
    }
  }
  return null;
}
