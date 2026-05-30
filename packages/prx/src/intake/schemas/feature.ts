import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const featureBodySchema = z.object({
  description: z.string().min(1),
  design: z.string().min(1).optional(),
  acceptance_criteria: z.string().min(1),
  notes: z.string().min(1).optional(),
});

export type FeatureBody = z.infer<typeof featureBodySchema>;

export const featureBodyFieldsMeta: IntakeFieldsMeta = {
  description: { actionsBearing: true, heading: "Description" },
  design: { actionsBearing: true, heading: "Design" },
  acceptance_criteria: { actionsBearing: true, heading: "Acceptance Criteria" },
  notes: { actionsBearing: false, heading: "Notes" },
};
