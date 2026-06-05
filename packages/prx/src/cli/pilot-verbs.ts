/**
 * SPIKE — `pilot` and `fleet` authored as spec-driven verbs. These are the
 * first canonical `VerbSpec`s: one Zod schema each, projected to CLI / MCP /
 * OpenAPI / tools by `verbspec.ts`, with `run` driving the real machines.
 *
 * (Uses `stubLegRunner` for the spike; prod swaps in the SDK leg-runner +
 * `resolveProvenanceSigner` — see pilot-runner.ts / pilot-signing.ts.)
 */

import { createActor, waitFor, type AnyStateMachine } from "xstate";
import { z } from "zod";

import { createFleetMachine, type FleetContext } from "../machine/machines/fleet.ts";
import { createPilotMachine, stubLegRunner } from "../machine/machines/pilot.ts";
import { defineVerb } from "./verbspec.ts";

export const pilotVerb = defineVerb({
  id: "pilot",
  summary: "Drive ONE work unit through the pipeline (plan → implement → CI → merge).",
  actor: "pilot",
  positionals: ["workUnitId"],
  input: z.object({
    workUnitId: z.string().min(1).describe("canonical work unit id, e.g. GH-456"),
    retreatBudget: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("failure-retreats allowed before the unit is abandoned"),
  }),
  output: z.object({
    workUnitId: z.string(),
    finalState: z.string(),
    legCount: z.number().int(),
    summarySignedBy: z.string().nullable(),
  }),
  run: async ({ workUnitId, retreatBudget }) => {
    const actor = createActor(createPilotMachine(stubLegRunner), {
      input: { workUnitId, ...(retreatBudget !== undefined ? { retreatBudget } : {}) },
    }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 4000 });
    return {
      workUnitId,
      finalState: String(done.value),
      legCount: done.context.chain.length,
      summarySignedBy: done.context.summary?.signedBy ?? null,
    };
  },
});

export const fleetVerb = defineVerb({
  id: "fleet",
  summary: "Kick off and supervise many pilots — the agents view.",
  actor: "fleet",
  positionals: ["units"],
  input: z.object({
    units: z.array(z.string().min(1)).min(0).describe("comma-separated work unit ids"),
    wip: z.coerce.number().int().min(1).optional().describe("max pilots in flight at once"),
  }),
  output: z.object({
    unitCount: z.number().int(),
    merged: z.number().int(),
    batchSignedBy: z.string().nullable(),
  }),
  run: async ({ units, wip }) => {
    const makePilot = (_u: string): AnyStateMachine =>
      createPilotMachine(stubLegRunner) as AnyStateMachine;
    const fleet = createActor(createFleetMachine(makePilot), {
      input: { units, ...(wip !== undefined ? { wip } : {}) },
    }).start();
    const drained = await waitFor(fleet, (s) => s.status === "done", { timeout: 8000 });
    const ctx = drained.context as FleetContext;
    const merged = Object.values(ctx.board).filter((e) => e.state === "merged").length;
    return {
      unitCount: units.length,
      merged,
      batchSignedBy: drained.output?.batch?.signedBy ?? null,
    };
  },
});

/** The spec-driven slice of the prx registry. */
export const orchestratorRegistry = {
  [pilotVerb.id]: pilotVerb,
  [fleetVerb.id]: fleetVerb,
};
