/**
 * operator-config — resolve the **operator-config root**: the directory holding
 * per-repo prx overlay config (`<root>/.prx/repos/<reverse-dns>/prx.toml`).
 *
 * This is the deployment-neutral successor to the hardcoded `ai-home` coupling
 * (GH-411). Resolution precedence, highest first:
 *
 *   1. `PRX_OPERATOR_CONFIG_ROOT` — runtime override (tests / non-nix runs).
 *   2. `PRX_AI_HOME_ROOT`        — deprecated alias, honored for one release so
 *                                  the current nix wrapper keeps working.
 *   3. baked default            — `bakedOperatorConfigRoot()` (compiled-in or
 *                                  `BAKED_OPERATOR_CONFIG_ROOT` / the
 *                                  `BAKED_AI_HOME_ROOT` alias).
 *
 * Returns `undefined` when no root is configured (plain dev / standalone prx) —
 * callers treat that as "no overlay".
 */
import { firstEnv } from "@bounded-systems/env";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { bakedOperatorConfigRoot } from "./build-info.ts";

/** The configured operator-config root, or undefined when none is set. */
export function operatorConfigRoot(): string | undefined {
  const override = firstEnv("PRX_OPERATOR_CONFIG_ROOT", "PRX_AI_HOME_ROOT");
  if (override !== null && override.length > 0) return override;
  const baked = bakedOperatorConfigRoot();
  return baked && baked.length > 0 ? baked : undefined;
}

/** Injectable fs/home seams so the readers below stay testable. */
export type OperatorConfigDeps = {
  readFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  homeDir?: string;
};

/** The path to the operator config (`~/.config/prx/config.json`). */
export function operatorConfigPath(deps: OperatorConfigDeps = {}): string | null {
  const home = deps.homeDir ?? homedir();
  if (!home) return null;
  return resolve(home, ".config", "prx", "config.json");
}

/**
 * Parse `~/.config/prx/config.json` into a plain object. The single reader for
 * the operator config — `provenance`, `homeUpdate.inputs` (GH-411 slice 3), and
 * `scopeMap` (slice 4) are all blocks within it. Returns `{}` when the file is
 * absent or malformed (config must never break a command).
 */
export function readOperatorConfig(deps: OperatorConfigDeps = {}): Record<string, unknown> {
  const path = operatorConfigPath(deps);
  if (!path) return {};
  const exists = deps.pathExists ?? ((p: string) => existsSync(p));
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  if (!exists(path)) return {};
  try {
    const parsed = JSON.parse(read(path)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Read a `Record<string,string>` block from the operator config (e.g.
 * `scopeMap`): drops non-string values, trims/filters empties. Returns `{}`
 * when absent/malformed.
 */
export function readOperatorConfigStringMap(
  key: string,
  deps: OperatorConfigDeps = {},
): Record<string, string> {
  const block = readOperatorConfig(deps)[key];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}
