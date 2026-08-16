import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const taskBodySchema = z.object({
  description: z.string().min(1),
  acceptance_criteria: z.string().min(1),
});

export type TaskBody = z.infer<typeof taskBodySchema>;

export const taskBodyFieldsMeta: IntakeFieldsMeta = {
  description: { actionsBearing: true, heading: "Description" },
  acceptance_criteria: { actionsBearing: true, heading: "Acceptance Criteria" },
};
