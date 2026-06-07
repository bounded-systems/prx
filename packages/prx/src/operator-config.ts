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

import { bakedOperatorConfigRoot } from "./build-info.ts";

/** The configured operator-config root, or undefined when none is set. */
export function operatorConfigRoot(): string | undefined {
  const override = firstEnv("PRX_OPERATOR_CONFIG_ROOT", "PRX_AI_HOME_ROOT");
  if (override !== null && override.length > 0) return override;
  const baked = bakedOperatorConfigRoot();
  return baked && baked.length > 0 ? baked : undefined;
}
