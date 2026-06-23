import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import {
  collectDrift,
  isPlainObject,
  nonObjectRootDrift,
  partition,
  type DriftReport,
} from "./drift.ts";

/** The subset of the Warp TUI configuration this package owns. */
export type TuiL2WarpSubset = {
  blocksUiMode?: "minimized" | "default";
  inputAutoFormatEnabled?: boolean;
  aiSuggestionOverlayEnabled?: boolean;
  sendAltAsMeta?: boolean;
  optionAsMeta?: boolean;
  rendering?: "standard" | "experimental";
};

/** Zod schema for validating a {@link TuiL2WarpSubset} config object. */
export const TuiL2WarpSchema = z
  .object({
    blocksUiMode: z.enum(["minimized", "default"]).optional(),
    inputAutoFormatEnabled: z.boolean().optional(),
    aiSuggestionOverlayEnabled: z.boolean().optional(),
    sendAltAsMeta: z.boolean().optional(),
    optionAsMeta: z.boolean().optional(),
    rendering: z.enum(["standard", "experimental"]).optional(),
  })
  .strict();

/** All keys managed by this module (the L2 Warp TUI slice). */
export const WARP_KEYS = [
  "blocksUiMode",
  "inputAutoFormatEnabled",
  "aiSuggestionOverlayEnabled",
  "sendAltAsMeta",
  "optionAsMeta",
  "rendering",
] as const satisfies readonly (keyof TuiL2WarpSubset)[];

/** Parsed L2 Warp TUI configuration: owned keys + passthrough unknowns. */
export type TuiL2Warp = {
  warp: TuiL2WarpSubset;
  passthrough: Record<string, unknown>;
};

/** Result of parsing a Warp TUI config — either the typed value or a drift report. */
export type ParseResult =
  | { ok: true; value: TuiL2Warp; drift: DriftReport }
  | { ok: false; drift: DriftReport };

const WARP_KEY_SET: ReadonlySet<string> = new Set<string>(WARP_KEYS);

/** Parse an unknown config object into a typed {@link TuiL2Warp} + drift report. */
export function parse(input: unknown): ParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, drift: nonObjectRootDrift(input) };
  }
  const { slice: warpSlice, passthrough } = partition(input, WARP_KEY_SET);
  const drift = collectDrift(TuiL2WarpSchema, warpSlice);
  const warp: TuiL2WarpSubset = {};
  for (const key of WARP_KEYS) {
    if (key in warpSlice) {
      const result = TuiL2WarpSchema.shape[key].safeParse(warpSlice[key]);
      if (result.success) {
        (warp as Record<string, unknown>)[key] = result.data;
      }
    }
  }
  return { ok: true, value: { warp, passthrough }, drift };
}

/** Return only the drift report for a raw config object, without full parsing. */
export function driftReport(input: unknown): DriftReport {
  if (!isPlainObject(input)) {
    return nonObjectRootDrift(input);
  }
  const { slice: warpSlice } = partition(input, WARP_KEY_SET);
  return collectDrift(TuiL2WarpSchema, warpSlice);
}

/** Serialize a {@link TuiL2Warp} profile back to a JSON string. */
export function emit(profile: TuiL2Warp): string {
  const merged: Record<string, unknown> = { ...profile.passthrough };
  for (const key of WARP_KEYS) {
    const value = (profile.warp as Record<string, unknown>)[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Parse a Warp TUI config from a JSON file at the given absolute path. */
export function parseFile(absPath: string): ParseResult {
  const raw = JSON.parse(readFileSync(absPath, "utf8"));
  return parse(raw);
}

/** Write a {@link TuiL2Warp} profile to a JSON file at the given absolute path. */
export function emitToFile(absPath: string, profile: TuiL2Warp): void {
  writeFileSync(absPath, emit(profile));
}
