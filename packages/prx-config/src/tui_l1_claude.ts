import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import {
  collectDrift,
  isPlainObject,
  nonObjectRootDrift,
  partition,
  type DriftReport,
} from "./drift.ts";

const voiceSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["hold", "tap"]).optional(),
    autoSubmit: z.boolean().optional(),
  })
  .strict();

export const TuiSubsetSchema = z
  .object({
    tui: z.enum(["fullscreen", "default"]).optional(),
    editorMode: z.enum(["normal", "vim"]).optional(),
    language: z.string().optional(),
    outputStyle: z.string().optional(),
    viewMode: z.enum(["default", "verbose", "focus"]).optional(),
    autoScrollEnabled: z.boolean().optional(),
    prefersReducedMotion: z.boolean().optional(),
    showThinkingSummaries: z.boolean().optional(),
    showTurnDuration: z.boolean().optional(),
    terminalProgressBarEnabled: z.boolean().optional(),
    spinnerTipsEnabled: z.boolean().optional(),
    awaySummaryEnabled: z.boolean().optional(),
    voice: voiceSchema.optional(),
  })
  .strict();

export type TuiSubset = z.infer<typeof TuiSubsetSchema>;

export const TUI_KEYS = [
  "tui",
  "editorMode",
  "language",
  "outputStyle",
  "viewMode",
  "autoScrollEnabled",
  "prefersReducedMotion",
  "showThinkingSummaries",
  "showTurnDuration",
  "terminalProgressBarEnabled",
  "spinnerTipsEnabled",
  "awaySummaryEnabled",
  "voice",
] as const satisfies readonly (keyof TuiSubset)[];

export type TuiL1Claude = {
  tui: TuiSubset;
  passthrough: Record<string, unknown>;
};

export type ParseResult =
  | { ok: true; value: TuiL1Claude; drift: DriftReport }
  | { ok: false; drift: DriftReport };

const TUI_KEY_SET: ReadonlySet<string> = new Set<string>(TUI_KEYS);

export function parse(input: unknown): ParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, drift: nonObjectRootDrift(input) };
  }
  const { slice: tuiSlice, passthrough } = partition(input, TUI_KEY_SET);
  const drift = collectDrift(TuiSubsetSchema, tuiSlice);
  const tui: TuiSubset = {};
  for (const key of TUI_KEYS) {
    if (key in tuiSlice) {
      const result = TuiSubsetSchema.shape[key].safeParse(tuiSlice[key]);
      if (result.success) {
        (tui as Record<string, unknown>)[key] = result.data;
      }
    }
  }
  return { ok: true, value: { tui, passthrough }, drift };
}

export function driftReport(input: unknown): DriftReport {
  if (!isPlainObject(input)) {
    return nonObjectRootDrift(input);
  }
  const { slice: tuiSlice } = partition(input, TUI_KEY_SET);
  return collectDrift(TuiSubsetSchema, tuiSlice);
}

export function emit(profile: TuiL1Claude): string {
  const merged: Record<string, unknown> = { ...profile.passthrough };
  for (const key of TUI_KEYS) {
    const value = (profile.tui as Record<string, unknown>)[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

export function parseFile(absPath: string): ParseResult {
  const raw = JSON.parse(readFileSync(absPath, "utf8"));
  return parse(raw);
}

export function emitToFile(absPath: string, profile: TuiL1Claude): void {
  writeFileSync(absPath, emit(profile));
}
