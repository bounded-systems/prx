// Per-row decision shapes returned by verb actors. Owned here so the verb
// files and `schemas/audit.ts` can both import from one location without
// chasing each other through cycles. Verb files re-export from here.

import { z } from "zod";

import { priorityLabelSchema, typeLabelSchema } from "../label-vocab.ts";

// `prx triage promote` per-row decision (promote.ts). GH-1403 moved this to
// the schemas layer so `schemas/audit.ts` can validate promote rows without
// pulling in `promote.ts` (which now imports the audit sink).
export const promoteDecisionSchema = z.enum([
  "promote",
  "skip:missing-labels",
  "skip:non-execution-type",
  "skip:already-in-bd",
]);
export type PromoteDecision = z.infer<typeof promoteDecisionSchema>;

// `prx triage prioritize` per-row choice (prioritize.ts:47).
export const priorityChoiceSchema = z.enum(["critical", "high", "medium", "low"]);
export type PriorityChoice = z.infer<typeof priorityChoiceSchema>;

// `prx triage prioritize` per-prompt key (prioritize.ts:48).
export const promptKeySchema = z.enum(["c", "h", "m", "l", "s", "q"]);
export type PromptKey = z.infer<typeof promptKeySchema>;

// `prx triage apply` per-row decision discriminated union (apply.ts:62-70).
export const applyDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skip"),
    row: z.object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      currentLabels: z.array(z.string()),
      type: typeLabelSchema.optional(),
      priority: priorityLabelSchema.optional(),
      area: z.string().optional(),
      effort: z.string().optional(),
    }),
    reason: z.literal("already-matches"),
  }),
  z.object({
    kind: z.literal("write"),
    row: z.object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      currentLabels: z.array(z.string()),
      type: typeLabelSchema.optional(),
      priority: priorityLabelSchema.optional(),
      area: z.string().optional(),
      effort: z.string().optional(),
    }),
    addLabels: z.array(z.string()),
    removeLabels: z.array(z.string()),
    proposed: z.array(z.string()),
  }),
]);
export type ApplyDecisionDoc = z.infer<typeof applyDecisionSchema>;
