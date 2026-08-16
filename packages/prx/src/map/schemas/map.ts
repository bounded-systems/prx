// Map record boundary schema (GH-2016 PR-1).
//
// A "map" is a named, cross-tree initiative — a coherent body of work spanning
// multiple epics, with rationale and ordering. Distinct from `bd mol` molecules
// (reusable templates) and from `prx plan next` (per-issue ready picker).
//
// On-disk substrate: `.prx/maps/<name>.json`. JSON (not YAML) matches the rest
// of `.prx/` (`.prx/repos/config.json`, `.prx/dep-research/manifest.json`) and
// avoids adding a YAML dep for the MVP — open question 4 in the GH-2016 plan.
//
// Source of truth: the JSON file. bd-graph edges are a downstream projection
// materialized by `prx map sync`; the projection writer never reads bd state
// back into the JSON (invariant mirrors I-PROJ1 from the workflow model).

import { z } from "zod";

// Ticket id form is intentionally loose: `GH-N` (the operator-facing form) and
// bd-internal IDs (`bd-xxxx`) both flow through. `prx map sync` resolves the
// id via `bd dep add`'s external-ref machinery; mis-typed ids surface there,
// not at the JSON boundary.
export const MapTicketId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "expected an issue id like GH-2011 or bd-xyz");
export type MapTicketId = z.infer<typeof MapTicketId>;

// Role labels describe a ticket's part in the map — gate (must land first to
// unblock the rest), implementation (the core work), fold-in (related ticket
// the map carries for visibility but does not gate on).
export const MapTicketRole = z.enum(["gate", "implementation", "fold-in"]);
export type MapTicketRole = z.infer<typeof MapTicketRole>;

// Priority axis matches the `priority::*` label vocab the triage actor writes.
// Optional — only set when the map asserts an override; absent means "honor
// whatever bd has".
export const MapTicketPriority = z.enum(["P0", "P1", "P2", "P3"]);
export type MapTicketPriority = z.infer<typeof MapTicketPriority>;

export const MapSequenceEntry = z.object({
  id: MapTicketId,
  role: MapTicketRole,
  priority: MapTicketPriority.optional(),
  depends: z.array(MapTicketId).default([]),
  relates: z.array(MapTicketId).default([]),
});
export type MapSequenceEntry = z.infer<typeof MapSequenceEntry>;

export const MapRecord = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "expected a kebab-case slug"),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  rationale: z.string().min(1),
  parents: z.array(MapTicketId).default([]),
  sequence: z.array(MapSequenceEntry).min(1),
});
export type MapRecord = z.infer<typeof MapRecord>;
