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
import { getEnv } from "@bounded-systems/env";

declare const __PRX_BUILD_GIT_SHA__: string | undefined;
declare const __PRX_BUILD_CLAUDE_CODE_PATH__: string | undefined;
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

export function bakedClaudeCodePath(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_CLAUDE_CODE_PATH__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_CLAUDE_CODE_PATH__)
      : undefined;
  return compiled ?? nonEmpty(getEnv("BAKED_CLAUDE_CODE_PATH"));
}

export function bakedAiHomeRoot(): string | undefined {
  const compiled =
    typeof __PRX_BUILD_AI_HOME_ROOT__ !== "undefined"
      ? nonEmpty(__PRX_BUILD_AI_HOME_ROOT__)
      : undefined;
  return compiled ?? nonEmpty(getEnv("BAKED_AI_HOME_ROOT"));
}
