// Shared bd→external axis-label projection (GH-2382).
//
// The bd-authoritative `type` / `priority` axes are projected onto GitHub
// `type::*` / `priority::*` labels by three independent surfaces — `prx beads
// publish` (single-record push), the `GhDomainAdapter.push` linked edit, and
// the `prx beads sync --domain=gh` push leg. Before GH-2382 each derived the
// desired label set with its own private copy of `issueLabelsFor` /
// `priorityLabelValue`; promoting them here makes all three derive the same
// labels from the same bd record, so the projection cannot drift between the
// publish path and the periodic reconcile.
//
// `axisLabelDiff` is the lossless add/remove core: given the live GH labels
// and the bd-desired set, it returns the minimal `{ add, remove }` that swaps
// the *managed* axes (type, priority) to the bd-authoritative values while
// preserving every foreign label and the GH-only `type::spike` / `decision`
// markers (GH-1489 / GH-1955). This is the mechanism `triage apply` and
// `adapter.push` share — strictly bd→external (invariant I-DS-PRIO / I-PROJ1):
// the live read is reconciliation-only and never feeds a bd-side write.

import { bdPriorityToLabel, type BeadsRecord } from "./triage.ts";
import { BD_TYPE_ENUM, LABEL_AXES, parseLabelName, type LabelAxis } from "./labels.ts";

/**
 * Coerce a bd `issueType` to the round-trippable GH `type::*` value. Values
 * outside `BD_TYPE_ENUM` (the beads `typeMapping` set) collapse to `task` —
 * the symmetric bd→GH coercion documented in `src/triage/labels.ts`
 * (`resolveBdTypeFromLabels` is the GH→bd inverse).
 */
export function ghTypeLabel(issueType: string): string {
  return (BD_TYPE_ENUM as readonly string[]).includes(issueType) ? issueType : "task";
}

/**
 * Map a bd numeric priority to the GH `priority::*` rung value.
 *
 * bd P4 (backlog) has no GH rung in the 4-rung `bdPriorityToLabel` (0-3 →
 * critical/high/medium/low). Clamp it to the lowest DELIBERATE rung `low`
 * ("accepted but deferrable", workflows/triage.md) rather than letting it fall
 * through to the GH-970 `none` UNTRIAGED sentinel — a backlog decision is still
 * a triage decision, and `none` would make `triage prioritize` re-surface it
 * and block `triage promote`'s operator-undecided gate (ai-home-o55ct /
 * GH-2313). A genuinely-unset bd priority (null) maps to `none`.
 */
export function priorityLabelValue(priority: number | null): string {
  if (priority === 4) return "low";
  const raw = bdPriorityToLabel(priority);
  return raw === "unknown" ? "none" : raw;
}

/** The bd-axis GH labels (`type::*` + `priority::*`) a bd record projects. */
export function issueLabelsFor(record: BeadsRecord): string[] {
  return [
    `type::${ghTypeLabel(record.issueType)}`,
    `priority::${priorityLabelValue(record.priority)}`,
  ];
}

/** The label axes a bd→external push is authoritative for (GH-2382 / ADR §2). */
export const PUSH_MANAGED_AXES: readonly LabelAxis[] = ["type", "priority"];

export type AxisLabelDiff = { add: string[]; remove: string[] };

/**
 * Is `label` a managed-axis label this push owns and may strip?
 *
 * A label is strippable iff it parses to one of `managedAxes` AND is not a
 * GH-only `type::*` marker. The spike / decision markers (`TYPE` enum values
 * not in `BD_TYPE_ENUM`) ride alongside the bd-axis `type::task` stamp and are
 * never the type-axis decision, so they are preserved across a push diff.
 */
function isStrippableAxisLabel(label: string, managedAxes: readonly LabelAxis[]): boolean {
  const parsed = parseLabelName(label);
  if (!parsed.known) return false;
  if (!managedAxes.includes(parsed.axis)) return false;
  if (parsed.axis === "type" && !(BD_TYPE_ENUM as readonly string[]).includes(parsed.value)) {
    return false;
  }
  return true;
}

/**
 * Lossless add/remove diff for projecting bd-authoritative labels onto a live
 * GH issue. `desired` is the full label set the caller wants present (the
 * bd-axis stamps plus any caller-folded extras, e.g. `area::*`); `live` is the
 * current GH label set. The diff:
 *
 *   - adds every `desired` label not already live, and
 *   - removes every live *managed-axis* label not in `desired` (so a priority
 *     rung bump strips the stale rung).
 *
 * Foreign labels (`agent::*`, `needs-triage`, …), labels at unmanaged axes
 * (`area::*` / `effort::*` — owned by `prx triage apply`), and the GH-only
 * `type::spike` / `type::decision` markers are never stripped. Returns empty
 * arrays when the issue already carries exactly the managed-axis set.
 */
export function axisLabelDiff(
  live: readonly string[],
  desired: readonly string[],
  managedAxes: readonly LabelAxis[] = PUSH_MANAGED_AXES,
): AxisLabelDiff {
  const liveSet = new Set(live);
  const wanted = new Set(desired);
  const add = desired.filter((l) => !liveSet.has(l));
  const remove = live.filter((l) => !wanted.has(l) && isStrippableAxisLabel(l, managedAxes));
  return { add, remove };
}

// Re-export so callers needing the axis vocabulary don't reach past this module.
export { LABEL_AXES };
