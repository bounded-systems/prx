// GH-1423: typed event union for the `rules` actor.
//
// Names use SCREAMING_SNAKE per `src/triage/schemas/events.ts` convention.
// The discriminated union is reified as a Zod schema so the actor's `setup`
// types in `machine.ts` can read the inferred type and callers from the
// CLI dispatcher can validate at the boundary.

import { z } from "zod";

const rulesRenderRequestedSchema = z.object({
  type: z.literal("RULES_RENDER_REQUESTED"),
  /** Stable identifier for the request; CLI sets it to the verb name. */
  source: z.string().min(1),
});

const rulesInputLoadedSchema = z.object({
  type: z.literal("RULES_INPUT_LOADED"),
  kind: z.enum([
    "verb-supply",
    "alias-supply",
    "worktree-gestures",
    "memory-index",
  ]),
  count: z.number().int().nonnegative(),
});

const rulesInputStubbedSchema = z.object({
  type: z.literal("RULES_INPUT_STUBBED"),
  kind: z.enum([
    "verb-supply",
    "alias-supply",
    "worktree-gestures",
    "memory-index",
  ]),
  ticket: z.string().min(1).optional(),
});

const rulesValidatedSchema = z.object({
  type: z.literal("RULES_VALIDATED"),
  assertionsRun: z.number().int().nonnegative(),
});

const rulesAssertionFailedSchema = z.object({
  type: z.literal("RULES_ASSERTION_FAILED"),
  rule: z.enum([
    "verb-exists",
    "alias-exists",
    "worktree-gesture-resolves",
  ]),
  subject: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
});

const rulesRenderedSchema = z.object({
  type: z.literal("RULES_RENDERED"),
  files: z.array(z.string().min(1)),
});

const rulesRenderFailedSchema = z.object({
  type: z.literal("RULES_RENDER_FAILED"),
  reason: z.string().min(1),
});

export const rulesEventSchema = z.discriminatedUnion("type", [
  rulesRenderRequestedSchema,
  rulesInputLoadedSchema,
  rulesInputStubbedSchema,
  rulesValidatedSchema,
  rulesAssertionFailedSchema,
  rulesRenderedSchema,
  rulesRenderFailedSchema,
]);
export type RulesEvent = z.infer<typeof rulesEventSchema>;

export type RulesAssertionFailedEvent = Extract<
  RulesEvent,
  { type: "RULES_ASSERTION_FAILED" }
>;
