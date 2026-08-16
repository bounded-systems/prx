// Triage classifier ↔ apply I/O contract — projects the canonical Zod label
// schema (./labels.ts, GH-918) into the row + plan shapes the classifier
// emits and apply consumes (GH-919, GH-937).
//
// The four-axis vocabulary lives in ./labels.ts. This module is the bridge:
// it re-exports the axis schemas under classifier-friendly names and adds the
// classifier-specific row/plan envelope plus the idempotent label-diff helper.

import { z } from "zod";

import {
  AREA,
  BD_TYPE_ENUM,
  EFFORT,
  PRIORITY,
  TYPE,
  parseLabelName,
  type LabelArea,
  type LabelEffort,
  type LabelPriority,
  type LabelType,
} from "./labels.ts";

export const typeLabelSchema = TYPE;
export const priorityLabelSchema = PRIORITY;
export const areaLabelSchema = AREA;
export const effortLabelSchema = EFFORT;

export const TYPE_LABELS = TYPE.options;
export const PRIORITY_LABELS = PRIORITY.options;
export const AREA_LABELS = AREA.options;
export const EFFORT_LABELS = EFFORT.options;

export type TypeLabel = LabelType;
export type PriorityLabel = LabelPriority;
export type AreaLabel = LabelArea;
export type EffortLabel = LabelEffort;

/**
 * Render a logical label as the GH label string (`type::feature`,
 * `priority::high`, `area::prx`, `effort::s`).
 */
export function typeLabelString(label: TypeLabel): string {
  return `type::${label}`;
}

export function priorityLabelString(label: PriorityLabel): string {
  return `priority::${label}`;
}

export function areaLabelString(label: AreaLabel): string {
  return `area::${label}`;
}

export function effortLabelString(label: EffortLabel): string {
  return `effort::${label}`;
}

/**
 * One row of classifier output. Carries the proposed labels for a single GH
 * issue plus the diff context apply needs (current labels + URL for the audit
 * log). All four axes are independent and optional: the classifier emits a
 * value only when a rule fires for that axis. An axis left undefined means
 * "no opinion" — apply must not add at that axis nor strip operator-set
 * labels there. This is the GH-952 invariant.
 *
 * `priorityConfidence` (GH-970) is provenance metadata for the priority axis:
 *   - "unscored": classifier emitted `priority::none` because no scored rule
 *      fired (today: every priority emission, since no scored rules exist yet).
 *   - "scored":   future classifier rules with real signal will set this.
 *   - "operator": reserved for the `prx triage prioritize` verb to tag rows
 *      where the operator made an explicit decision.
 *
 * `typeConfidence` (GH-988) is the symmetric provenance bit for the type
 * axis. Same three-value enum, same shape — "unscored" tags the fallback
 * `type::task` emission for non-matching titles; "scored" tags titles that
 * matched a TYPE_RULES arm; "operator" is reserved for a future
 * `prx triage typify` verb.
 *
 * `spike` (GH-988 + GH-1489) is a GH-only side-channel bit that lives
 * alongside the bd-axis `type`. When true, `proposedLabelsFor` projects
 * `type::spike` into the label set in addition to `type::task`. Set by
 * title-driven matches (`spike(...)` / `spike:`) and by carrying forward
 * an existing `type::spike` label so legacy spike-only issues are not
 * stripped on apply.
 *
 * Apply does not branch on `priorityConfidence` or `typeConfidence` — both
 * fields are informational at the apply boundary. Preservation of
 * operator-set labels is governed by the `hasPriority` / `hasType` gates in
 * `proposedLabelsFor` regardless of confidence.
 */
export const typeConfidenceSchema = z.enum(["unscored", "scored", "operator"]);
export type TypeConfidence = z.infer<typeof typeConfidenceSchema>;

export const labelPlanRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  currentLabels: z.array(z.string()),
  type: typeLabelSchema.optional(),
  typeConfidence: typeConfidenceSchema.optional(),
  priority: priorityLabelSchema.optional(),
  priorityConfidence: z.enum(["unscored", "scored", "operator"]).optional(),
  area: areaLabelSchema.optional(),
  effort: effortLabelSchema.optional(),
  spike: z.boolean().optional(),
});

export type LabelPlanRow = z.infer<typeof labelPlanRowSchema>;

export const labelPlanSchema = z.object({
  repo: z.string().min(1),
  generatedAt: z.string(),
  rows: z.array(labelPlanRowSchema),
});

export type LabelPlan = z.infer<typeof labelPlanSchema>;

// GH-1710: bd-canonical row shape. Mirrors `labelPlanRowSchema` but keyed by
// bd id (no GH `number`/`url`) and carries the bd-native `currentPriority`
// (numeric 0..3 or null) and `currentType` (string or null) so the apply side
// can build `bd update <id>` mutations without a second read.
export const bdLabelPlanRowSchema = z.object({
  bdId: z.string().min(1),
  title: z.string(),
  currentPriority: z.number().int().min(0).max(3).nullable(),
  currentType: z.string(),
  type: typeLabelSchema.optional(),
  typeConfidence: typeConfidenceSchema.optional(),
  priority: priorityLabelSchema.optional(),
  priorityConfidence: z.enum(["unscored", "scored", "operator"]).optional(),
  area: areaLabelSchema.optional(),
  effort: effortLabelSchema.optional(),
});
export type BdLabelPlanRow = z.infer<typeof bdLabelPlanRowSchema>;

export const bdLabelPlanSchema = z.object({
  repo: z.string().min(1),
  canonical: z.literal("bd"),
  generatedAt: z.string(),
  rows: z.array(bdLabelPlanRowSchema),
});
export type BdLabelPlan = z.infer<typeof bdLabelPlanSchema>;

export function validateBdLabelPlan(input: unknown): BdLabelPlan {
  return bdLabelPlanSchema.parse(input);
}

/**
 * Validate a parsed plan and return the typed shape. Throws on invalid input.
 */
export function validateLabelPlan(input: unknown): LabelPlan {
  return labelPlanSchema.parse(input);
}

/**
 * Compute the proposed full label set for a row: current labels minus any
 * stale axis labels at axes the classifier emitted, plus the classifier's
 * new ones. Preserves order of surviving labels and appends the new ones
 * (deduped).
 *
 * Per-axis emission is gated on two conditions:
 *   - GH-952 (no-rule-fire): classifier silent at an axis ⇒ no add, no strip.
 *   - GH-957 (rule-fire complement): currentLabels already contain a
 *     `<axis>::*` label ⇒ axis is operator-set and authoritative, classifier
 *     output is suppressed (no add, no strip). Apply is additive on missing
 *     axes only — it never overwrites an operator-curated axis.
 *   - GH-1487 (priority::none carve-out): `priority::none` is the GH-970
 *     unscored sentinel — the absence of a decision, not an operator decision.
 *     It does not count as operator-set on the priority axis, so a classifier
 *     emission at `priority::*` strips it and replaces. Mirrors the
 *     `selectCandidates` reading in `prx triage prioritize`.
 *   - GH-988 (type::task carve-out): symmetric mirror of GH-1487 on the type
 *     axis. `type::task` is the classifier's unscored fallback sentinel — the
 *     absence of a scored type decision. It does not count as operator-set,
 *     so a future scored emission (or `prx triage typify`) strips and
 *     replaces it. The GH-only `type::spike` marker is not in `BD_TYPE_ENUM`
 *     and so does not count toward `hasType` — it rides alongside the
 *     bd-axis stamp via `row.spike`.
 */
export function proposedLabelsFor(
  row: LabelPlanRow,
  effectiveLabels?: readonly string[],
): string[] {
  // GH-1866 — when `effectiveLabels` is provided (a live GH snapshot fetched
  // by `runTriageApply`), the per-axis emission gates are computed against
  // it rather than the plan's bd-cache `currentLabels`. This fixes the
  // stale-bd-vs-fresh-GH divergence that stacked duplicate `type::*` on
  // operator-set issues. The strip-and-emit pass below also runs against the
  // effective snapshot so the resulting set matches what's actually on the
  // issue today.
  const source = effectiveLabels ?? row.currentLabels;
  const hasType = source.some((l) => {
    const p = parseLabelName(l);
    return (
      p.known &&
      p.axis === "type" &&
      (BD_TYPE_ENUM as readonly string[]).includes(p.value) &&
      p.value !== "task"
    );
  });
  const hasPriority = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "priority" && p.value !== "none";
  });
  const hasArea = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "area";
  });
  const hasEffort = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "effort";
  });

  const emitType = hasType ? undefined : row.type;
  const emitPriority = hasPriority ? undefined : row.priority;
  const emitArea = hasArea ? undefined : row.area;
  const emitEffort = hasEffort ? undefined : row.effort;
  // GH-988: project type::spike alongside type::task whenever the row carries
  // the spike bit. The marker is GH-only (not in BD_TYPE_ENUM) and does not
  // count toward `hasType`, so it neither blocks classifier emission nor
  // gets stripped by the per-axis sweep below.
  const emitSpike = row.spike === true;

  const next = new Set<string>();
  for (const label of source) {
    if (emitType !== undefined && label.startsWith("type::") && label !== "type::spike") continue;
    if (emitPriority !== undefined && label.startsWith("priority::")) continue;
    if (emitArea !== undefined && label.startsWith("area::")) continue;
    if (emitEffort !== undefined && label.startsWith("effort::")) continue;
    next.add(label);
  }
  if (emitType !== undefined) next.add(typeLabelString(emitType));
  if (emitSpike) next.add("type::spike");
  if (emitPriority !== undefined) next.add(priorityLabelString(emitPriority));
  if (emitArea !== undefined) next.add(areaLabelString(emitArea));
  if (emitEffort !== undefined) next.add(effortLabelString(emitEffort));
  return [...next];
}
