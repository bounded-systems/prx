import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const bugBodySchema = z.object({
  description: z.string().min(1),
  repro_steps: z.string().min(1).optional(),
  expected: z.string().min(1).optional(),
  actual: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  acceptance_criteria: z.string().min(1),
});

export type BugBody = z.infer<typeof bugBodySchema>;

export const bugBodyFieldsMeta: IntakeFieldsMeta = {
  description: { actionsBearing: true, heading: "Description" },
  repro_steps: { actionsBearing: false, heading: "Repro Steps" },
  expected: { actionsBearing: false, heading: "Expected" },
  actual: { actionsBearing: false, heading: "Actual" },
  environment: { actionsBearing: false, heading: "Environment" },
  acceptance_criteria: { actionsBearing: true, heading: "Acceptance Criteria" },
};
