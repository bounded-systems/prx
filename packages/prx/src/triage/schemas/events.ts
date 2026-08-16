// XState event schemas for the triage machine. Per-actor `done.invoke.<name>`
// events are auto-typed by XState from the actor signatures — what we
// hand-author here is the operator-controlled events.
//
// Forward-declared `WAIT_FOR_OPERATOR_APPROVAL` covers the `prioritizeBulk`
// greenlight pattern (will be wired by GH-1047). The slot exists on the
// machine union so future PRs land it without widening the type.

import { z } from "zod";

export const triageResetEventSchema = z.object({
  type: z.literal("TRIAGE_RESET"),
});

export const reloadStatusEventSchema = z.object({
  type: z.literal("RELOAD_STATUS"),
});

export const operatorApprovalEventSchema = z.object({
  type: z.literal("WAIT_FOR_OPERATOR_APPROVAL"),
  approve: z.boolean(),
});

export const triageMachineEventSchema = z.discriminatedUnion("type", [
  triageResetEventSchema,
  reloadStatusEventSchema,
  operatorApprovalEventSchema,
]);
export type TriageMachineEvent = z.infer<typeof triageMachineEventSchema>;
