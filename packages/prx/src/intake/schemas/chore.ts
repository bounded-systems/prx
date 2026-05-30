import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const choreBodySchema = z.object({
  description: z.string().min(1),
  acceptance_criteria: z.string().min(1),
});

export type ChoreBody = z.infer<typeof choreBodySchema>;

export const choreBodyFieldsMeta: IntakeFieldsMeta = {
  description: { actionsBearing: true, heading: "Description" },
  acceptance_criteria: { actionsBearing: true, heading: "Acceptance Criteria" },
};
