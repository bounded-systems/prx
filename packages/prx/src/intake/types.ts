/**
 * Pure-leaf intake type vocab (GH-1687).
 *
 * Holds the stable intake-axis constants that were previously declared inside
 * `src/intake/intake.ts`. Splitting them into a leaf module breaks the
 * `intake.ts ↔ triage/schemas/promote-children.ts` ES-module-init cycle that
 * surfaced as TDZ failures on CI Linux bun after the GH-1659 merge shifted
 * test-file discovery order (and so module evaluation order).
 *
 * Constraints:
 *   - This module must not import anything that re-enters intake/ or triage/
 *     at init time.
 *   - No IIFEs, no top-level function calls, no throw-on-init.
 */

// bd-axis types: round-trippable through beads `typeMapping`. These are the
// values the `type::*` GH label carries on the bd axis and what bd's
// `issue_type` column stores. Spike intent maps onto `task` here (GH-1489).
export const INTAKE_TYPES = ["bug", "task", "feature", "chore"] as const;
export type IntakeType = (typeof INTAKE_TYPES)[number];

// CLI-surface intents: what an operator types after `prx intake`. `spike`
// (GH-1489) and `decision` (GH-1955) are operator-facing intents that resolve
// to `type::task` on the bd axis plus a GH-only marker label (`type::spike` /
// `type::decision`). The split keeps bd's narrow vocab intact while preserving
// the marker artifact-shape for triage / scout / audit consumers.
export const INTAKE_INTENTS = [...INTAKE_TYPES, "spike", "decision"] as const;
export type IntakeIntent = (typeof INTAKE_INTENTS)[number];

export type IntentSpec = {
  /** bd-axis type that gets stamped as `type::<X>` at issue-creation time. */
  type: IntakeType;
  /** Additional GH-only labels the intent contributes (e.g. `type::spike`). */
  extraLabels: readonly string[];
  /** Conv-commit-style title prefix (`bug`, `spike`, ...). */
  titlePrefix: string;
};

export const INTENT_TO_SPEC: Record<IntakeIntent, IntentSpec> = {
  bug: { type: "bug", extraLabels: [], titlePrefix: "bug" },
  task: { type: "task", extraLabels: [], titlePrefix: "task" },
  feature: { type: "feature", extraLabels: [], titlePrefix: "feature" },
  chore: { type: "chore", extraLabels: [], titlePrefix: "chore" },
  spike: { type: "task", extraLabels: ["type::spike"], titlePrefix: "spike" },
  decision: { type: "task", extraLabels: ["type::decision"], titlePrefix: "decision" },
};

// Conv-commit + intake-type vocab; matches GH-1122 normalization regex.
export const PREFIX_RE = /^(feat|fix|bug|chore|docs|refactor|test|feature|task|spike|decision)(?:\(([^)]+)\))?:\s+/;

// feat→feature, fix→bug; identity for bug|task|feature|chore|spike|decision.
// docs|refactor|test have no intake-intent counterpart — always mismatch.
export const PREFIX_TO_INTAKE_INTENT: Record<string, IntakeIntent | null> = {
  feat: "feature",
  fix: "bug",
  bug: "bug",
  task: "task",
  feature: "feature",
  chore: "chore",
  spike: "spike",
  decision: "decision",
  docs: null,
  refactor: null,
  test: null,
};
