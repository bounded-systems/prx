// Triage label vocabulary — Zod-first source of truth (GH-918).
//
// GH labels are a projection of this schema. `prx triage status` reads
// required-fields from here; `prx tools labels sync` writes the schema → GH
// idempotently. The four axes are independent: an issue's full triage label
// state is a `Label` object (type + priority required, area + effort optional).
//
// Triage produces no XState events; this module is read-only metadata.

import { z } from "zod";

// `spike` (GH-1489) and `decision` (GH-1955) are intentionally GH-only: they
// ship in the projected GH label vocab so `prx intake spike` / `prx intake
// decision` can stamp `type::spike` / `type::decision` alongside the bd-axis
// `type::task`, but neither is in `BD_TYPE_ENUM` below — beads `typeMapping`
// does not round-trip them. See the `BD_TYPE_ENUM` block-comment for the
// divergence rationale.
export const TYPE = z.enum([
  "bug",
  "feature",
  "task",
  "chore",
  "epic",
  "spike",
  "decision",
]);

// `none` (GH-970) is the explicit unscored marker — the operator has not
// decided yet. `prx triage status` counts it as untriaged (see triage.ts:329).
// All other values are operator-scored.
export const PRIORITY = z.enum(["critical", "high", "medium", "low", "none"]);

export const AREA = z.enum([
  "prx",
  "beads",
  "notion",
  "tmux",
  "ci",
  "home-manager",
  "tui",
  "warp",
  "claude-code",
]);

export const EFFORT = z.enum(["xs", "s", "m", "l", "xl"]);

export const labelSchema = z.object({
  type: TYPE,
  priority: PRIORITY,
  area: AREA.optional(),
  effort: EFFORT.optional(),
});

export type LabelType = z.infer<typeof TYPE>;
export type LabelPriority = z.infer<typeof PRIORITY>;
export type LabelArea = z.infer<typeof AREA>;
export type LabelEffort = z.infer<typeof EFFORT>;
export type Label = z.infer<typeof labelSchema>;

// bd's *round-trippable* type set, per upstream `gastownhall/beads`
// `internal/github/types.go` `typeMapping` at v1.0.3. These are the only
// `type::*` labels that survive `bd github sync` without being silently
// coerced to `task`. The broader `IssueType` enum in beads's
// `internal/types/types.go` includes `decision/spike/story/milestone`, but
// those values are not in `typeMapping` and so round-trip incorrectly today
// (gastownhall/beads#3604).
//
// The prx `TYPE` enum above is intentionally a *superset* of this list:
// `spike` (GH-1489) and `decision` (GH-1955) are GH-only marker labels that
// ride alongside a `type::task` bd-axis stamp — `prx intake spike` /
// `prx intake decision` write both labels so the marker-shaped artifact is
// preserved on GH while bd round-trips cleanly as `task`. Expand
// `BD_TYPE_ENUM` only when beads's `typeMapping` expands to match.
export const BD_TYPE_ENUM = ["bug", "feature", "task", "epic", "chore"] as const;

export type LabelAxis = "type" | "priority" | "area" | "effort";

const AXIS_TO_ENUM: Record<LabelAxis, z.ZodEnum<[string, ...string[]]>> = {
  type: TYPE,
  priority: PRIORITY,
  area: AREA,
  effort: EFFORT,
};

export const LABEL_AXES: readonly LabelAxis[] = ["type", "priority", "area", "effort"];

export type ParsedLabel =
  | { known: true; axis: LabelAxis; value: string; raw: string }
  | { known: false; raw: string };

const SEPARATOR = "::";

// Parse a GH label name like `type::feature` into a known axis+value, or
// return `{ known: false }` for anything outside the schema (legacy labels
// like `agent::architect`, plain `bug`, `documentation`, etc.).
export function parseLabelName(raw: string): ParsedLabel {
  if (typeof raw !== "string") return { known: false, raw: String(raw ?? "") };
  const idx = raw.indexOf(SEPARATOR);
  if (idx <= 0) return { known: false, raw };
  const prefix = raw.slice(0, idx);
  const value = raw.slice(idx + SEPARATOR.length);
  if (!isAxis(prefix)) return { known: false, raw };
  const enumSchema = AXIS_TO_ENUM[prefix];
  const result = enumSchema.safeParse(value);
  if (!result.success) return { known: false, raw };
  return { known: true, axis: prefix, value, raw };
}

function isAxis(prefix: string): prefix is LabelAxis {
  return (LABEL_AXES as readonly string[]).includes(prefix);
}

// Resolve the bd-axis `type` value implied by a GH issue's labels, honoring the
// GH-only-marker model (GH-1489 spike, GH-1955 decision). A GH-only marker is
// any `TYPE.options` value that's *not* in `BD_TYPE_ENUM`; it rides alongside
// a bd-axis `type::*` label (`prx intake spike` / `prx intake decision` stamp
// both), and beads round-trips it as `task`. So the bd-side type is whichever
// `type::*` label is in `BD_TYPE_ENUM` (order-independent — markers are never
// in `BD_TYPE_ENUM`); a lone marker label resolves to `task` — the symmetric
// bd→GH coercion (a bd `issueType` outside `BD_TYPE_ENUM` becomes `"task"`)
// lives in `prx beads publish`. Used by `findDrift` so legacy marker-only
// issues stop surfacing as permanent drift. See GH-1532.
//
// Returns `null` when no `type::*` label is present — the type axis is *unset*,
// not a disagreement (already covered by the forward-orphan `missing[type]`
// path). Truly out-of-vocab values (not in `TYPE.options`, e.g. `type::story`)
// pass through verbatim so triage keeps surfacing them as drift.
export function resolveBdTypeFromLabels(labelNames: string[]): string | null {
  const prefix = `type${SEPARATOR}`;
  const typeValues: string[] = [];
  for (const name of labelNames) {
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    const value = name.slice(prefix.length);
    if (value.length > 0) typeValues.push(value);
  }
  if (typeValues.length === 0) return null;
  const bdMember = typeValues.find((v) => (BD_TYPE_ENUM as readonly string[]).includes(v));
  if (bdMember) return bdMember;
  const bdSet = new Set<string>(BD_TYPE_ENUM);
  const ghOnlyMarker = typeValues.find(
    (v) => (TYPE.options as readonly string[]).includes(v) && !bdSet.has(v),
  );
  if (ghOnlyMarker) return "task";
  return typeValues[0]!;
}

// Format a parsed axis+value back into a GH label name.
export function labelName(axis: LabelAxis, value: string): string {
  return `${axis}${SEPARATOR}${value}`;
}

// GH-935: predicate for `prx session open` epic-refusal guard. `labels` is the
// shape returned by `gh issue view --json labels` (`{ name: string }[]`); we
// accept any iterable carrying `.name` so callers don't have to reshape.
export function hasEpicLabel(labels: Iterable<{ name: string }> | null | undefined): boolean {
  if (!labels) return false;
  for (const label of labels) {
    const parsed = parseLabelName(label.name);
    if (parsed.known && parsed.axis === "type" && parsed.value === "epic") return true;
  }
  return false;
}

export type LabelDefinition = {
  name: string;
  axis: LabelAxis;
  value: string;
  description: string;
  color: string;
};

// Default colors per axis. Plain hex (no leading `#`), per `gh label create`.
// GitHub-light-grey (ededed) is what the existing labels use; we keep that
// for type/priority and assign distinct neutrals for the new area/effort axes
// so the projection visibly reflects the schema's two new dimensions.
const AXIS_COLOR: Record<LabelAxis, string> = {
  type: "ededed",
  priority: "ededed",
  area: "c5def5",
  effort: "fef2c0",
};

const AXIS_DESCRIPTION: Record<LabelAxis, (value: string) => string> = {
  type: (v) => `type axis: ${v}`,
  priority: (v) => `priority axis: ${v}`,
  area: (v) => `area axis: ${v}`,
  effort: (v) => `effort axis: ${v}`,
};

// All label definitions the schema would project onto GH.
export function defaultLabelDefinitions(): LabelDefinition[] {
  const defs: LabelDefinition[] = [];
  for (const axis of LABEL_AXES) {
    const enumSchema = AXIS_TO_ENUM[axis];
    for (const value of enumSchema.options) {
      defs.push({
        name: labelName(axis, value),
        axis,
        value,
        description: AXIS_DESCRIPTION[axis](value),
        color: AXIS_COLOR[axis],
      });
    }
  }
  return defs;
}

// Set of names a `gh label list` projection should contain. Used by
// `prx tools labels sync` to compute the create/update/delete diff.
export function schemaLabelNames(): Set<string> {
  return new Set(defaultLabelDefinitions().map((d) => d.name));
}
