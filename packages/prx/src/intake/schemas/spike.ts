import { z } from "zod";

import type { IntakeFieldsMeta } from "./meta.ts";

export const spikeBodySchema = z.object({
  question: z.string().min(1),
  proposed_approach: z.string().min(1).optional(),
  time_box: z.string().min(1).optional(),
  success_criteria: z.string().min(1),
  design: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});

export type SpikeBody = z.infer<typeof spikeBodySchema>;

export const spikeBodyFieldsMeta: IntakeFieldsMeta = {
  question: { actionsBearing: false, heading: "Question" },
  proposed_approach: { actionsBearing: true, heading: "Proposed Approach" },
  time_box: { actionsBearing: false, heading: "Time Box" },
  success_criteria: { actionsBearing: true, heading: "Success Criteria" },
  design: { actionsBearing: true, heading: "Design" },
  notes: { actionsBearing: false, heading: "Notes" },
};
