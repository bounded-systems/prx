// Build-time metadata. Two delivery paths, in precedence order:
//
//   1. Compiled binary — `bun build --define __PRX_BUILD_*__="…"` bakes the
//      value into the bundle (scripts/prx-compile.ts, and `prx ci --phase=build`
//      in pr-state/local-ci.ts). The define targets these plain globals,
//      deliberately NOT the ambient BAKED_* env keys, so @bounded-systems/env stays the sole reader
//      of ambient env and baked values arrive as a normal import edge.
//   2. Runtime env override — in a non-compiled run (`bun run`, tests, or a
//      child process local-ci hands `BAKED_*` to), the global is undefined and
//      the value comes from the `BAKED_*` env var, read through @bounded-systems/env.
//
// When neither is present (plain dev) the getters return undefined and callers
// fall back to runtime resolution (git rev-parse, default paths).
import { firstEnv, getEnv } from "@bounded-systems/env";

declare const __PRX_BUILD_GIT_SHA__: string | undefined;
declare const __PRX_BUILD_VERSION__: string | undefined;
declare const __PRX_BUILD_CLAUDE_CODE_PATH__: string | undefined;
declare const __PRX_BUILD_OPERATOR_CONFIG_ROOT__: string | undefined;
// Deprecated alias kept for one release (GH-411 slice 1): older binaries / the
// current nix wrapper still bake `__PRX_BUILD_AI_HOME_ROOT__`. Read as a
// fallback so a rename in prx doesn't require the nix side to move in lockstep.
declare const __PRX_BUILD_AI_HOME_ROOT__: string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function bakedGitSha(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_GIT_SHA__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_GIT_SHA__)
      : undefined;
  return compiled ?? nonEmpty(getEnv("BAKED_GIT_SHA"));
}

/**
 * prx-1ab: the release tag the binary was built from (e.g. `v0.1.14`). Baked at
 * release-build time from `github.ref_name` (the pushed `v*` tag) via
 * `PRX_COMPILE_VERSION`; absent for dev / non-tag builds, where callers fall
 * back to the git-SHA identity. This is what makes the binary report (and
 * self-check) by *release* rather than by commit distance from origin/main.
 */
export function bakedReleaseVersion(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_VERSION__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_VERSION__)
      : undefined;
  return compiled ?? nonEmpty(getEnv("BAKED_VERSION"));
}

export function bakedClaudeCodePath(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_CLAUDE_CODE_PATH__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_CLAUDE_CODE_PATH__)
      : undefined;
  return compiled ?? nonEmpty(getEnv("BAKED_CLAUDE_CODE_PATH"));
}

/**
 * The baked default for the operator-config root — the root holding per-repo
 * prx overlay config. GH-411 slice 1 renamed this from `bakedAiHomeRoot`:
 * `BAKED_AI_HOME_ROOT` / `__PRX_BUILD_AI_HOME_ROOT__` are read as deprecated
 * aliases for one release so the nix wrapper and older binaries keep working.
 */
export function bakedOperatorConfigRoot(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_OPERATOR_CONFIG_ROOT__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_OPERATOR_CONFIG_ROOT__)
      : typeof __PRX_BUILD_AI_HOME_ROOT__ !== "undefined"
        ? nonEmpty(__PRX_BUILD_AI_HOME_ROOT__)
        : undefined;
  return compiled ?? nonEmpty(firstEnv("BAKED_OPERATOR_CONFIG_ROOT", "BAKED_AI_HOME_ROOT") ?? undefined);
}
