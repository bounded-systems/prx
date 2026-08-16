/**
 * Per-field intake metadata (GH-1359).
 *
 * `IntakeFieldsMeta` declares the canonical H2 heading and the
 * `actionsBearing` classification for every property in a per-type
 * intake body schema.
 *
 *  - `heading` is the literal `## <heading>` string `composeStructuredBody`
 *    emits and `parseStructuredBody` recognises. Heading text lives here so
 *    emitter and parser cannot drift.
 *  - `actionsBearing` declares whether the section may legitimately declare
 *    planned writes. The schema-aware `extractPlannedActions` routes only
 *    `actionsBearing: true` sections through the action regex pipeline so
 *    descriptive text in Repro / Expected / Actual / Notes does not
 *    produce false-positive `infeasible-action` findings in
 *    `prx plan preflight`.
 */
export type IntakeFieldMeta = {
  /** True iff the section can legitimately declare planned writes. */
  actionsBearing: boolean;
  /** Canonical H2 heading text — `## <heading>` in composed bodies. */
  heading: string;
};

export type IntakeFieldsMeta = Readonly<Record<string, IntakeFieldMeta>>;
