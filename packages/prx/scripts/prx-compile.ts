#!/usr/bin/env bun
/**
 * prx-compile — single compile interface for the self-contained prx binary.
 *
 * Used by all three bake sites (nix home-manager activation, package.json
 * `prx:build`, and ci.yml) so the `bun build --compile` invocation and its
 * `--define` set live in exactly one place. Env overrides let nix — which
 * cannot `git rev-parse` a read-only store path and must point the SDK at the
 * user's $HOME claude CLI — supply baked values that dev/CI derive locally.
 *
 * Usage:
 *   bun scripts/prx-compile.ts <outfile>
 *
 * Env overrides:
 *   PRX_COMPILE_GIT_SHA       baked git SHA (default: rev-parse --short=12)
 *   PRX_COMPILE_CLAUDE_PATH   baked native claude CLI path (default: $HOME/.local/bin/claude)
 *   PRX_COMPILE_AI_HOME_ROOT  bake BAKED_AI_HOME_ROOT (nix only; else omitted)
 *   BUN                       bun binary to invoke (default: bun)
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const outfile = process.argv[2];
if (!outfile) {
  console.error("prx-compile: outfile required (usage: bun scripts/prx-compile.ts <outfile>)");
  process.exit(2);
}

// rev-parse failures (shallow/no-git) collapse to '' — same as the old bash
// `|| echo ''`, so the BAKED_GIT_SHA define stays well-formed.
function gitShaShort(): string {
  const res = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

const sha = process.env.PRX_COMPILE_GIT_SHA ?? gitShaShort();
const claudePath = process.env.PRX_COMPILE_CLAUDE_PATH ?? join(homedir(), ".local/bin/claude");

// Each --define value is a JS string literal — the inner quotes are literal
// characters in the replacement text, not shell quoting (spawnSync passes argv
// verbatim, no shell parsing).
const defines = [
  "--define", `__PRX_BUILD_GIT_SHA__="${sha}"`,
  "--define", `__PRX_BUILD_CLAUDE_CODE_PATH__="${claudePath}"`,
];

const aiHomeRoot = process.env.PRX_COMPILE_AI_HOME_ROOT;
if (aiHomeRoot) {
  defines.push("--define", `__PRX_BUILD_AI_HOME_ROOT__="${aiHomeRoot}"`);
}

const bun = process.env.BUN ?? "bun";
const result = spawnSync(
  bun,
  ["build", "--compile", ...defines, "packages/prx/scripts/pr_state.ts", "--outfile", outfile],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
