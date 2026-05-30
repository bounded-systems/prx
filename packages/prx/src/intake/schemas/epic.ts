import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const epicBodySchema = z.object({
  description: z.string().min(1),
  child_decomposition: z.string().min(1),
  success_criteria: z.string().min(1),
});

export type EpicBody = z.infer<typeof epicBodySchema>;

export const epicBodyFieldsMeta: IntakeFieldsMeta = {
  description: { actionsBearing: true, heading: "Description" },
  child_decomposition: { actionsBearing: true, heading: "Child Decomposition" },
  success_criteria: { actionsBearing: true, heading: "Success Criteria" },
};
