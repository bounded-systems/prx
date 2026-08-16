// XState event schemas for the `prx map` actor machine (GH-2016 PR-1).
//
// Discriminated union over operator-facing events; per-actor `done.invoke.*`
// envelopes are auto-typed by XState from the actor signatures (see
// src/map/actors.ts).

import { z } from "zod";

export const mapCreatedEventSchema = z.object({
  type: z.literal("MAP_CREATED"),
  name: z.string().min(1),
});

export const mapShownEventSchema = z.object({
  type: z.literal("MAP_SHOWN"),
  name: z.string().min(1),
});

export const mapNextProjectedEventSchema = z.object({
  type: z.literal("MAP_NEXT_PROJECTED"),
  name: z.string().min(1).nullable(),
});

export const mapSyncStartedEventSchema = z.object({
  type: z.literal("MAP_SYNC_STARTED"),
  name: z.string().min(1),
});

export const mapSyncCompletedEventSchema = z.object({
  type: z.literal("MAP_SYNC_COMPLETED"),
  name: z.string().min(1),
  edgesWritten: z.number().int().nonnegative(),
});

export const mapSyncFailedEventSchema = z.object({
  type: z.literal("MAP_SYNC_FAILED"),
  name: z.string().min(1),
  message: z.string().min(1),
});

export const mapMachineEventSchema = z.discriminatedUnion("type", [
  mapCreatedEventSchema,
  mapShownEventSchema,
  mapNextProjectedEventSchema,
  mapSyncStartedEventSchema,
  mapSyncCompletedEventSchema,
  mapSyncFailedEventSchema,
]);
export type MapMachineEvent = z.infer<typeof mapMachineEventSchema>;
