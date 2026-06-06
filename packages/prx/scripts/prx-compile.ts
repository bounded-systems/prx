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
 *   bun scripts/prx-compile.ts <outfile> [--target <bun-target>]
 *
 * `--target` (or PRX_COMPILE_TARGET) cross-compiles for another platform via
 * `bun build --compile --target` — e.g. `bun-linux-arm64` to bake the Linux prx
 * the keeperd VM runs (GH-201). Omitted ⇒ a host build (unchanged behavior).
 *
 * Env overrides:
 *   PRX_COMPILE_GIT_SHA       baked git SHA (default: rev-parse --short=12)
 *   PRX_COMPILE_CLAUDE_PATH   baked native claude CLI path (default: $HOME/.local/bin/claude)
 *   PRX_COMPILE_AI_HOME_ROOT  bake BAKED_AI_HOME_ROOT (nix only; else omitted)
 *   PRX_COMPILE_TARGET        bun --compile target (default: host; CLI --target wins)
 *   BUN                       bun binary to invoke (default: bun)
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// outfile is the sole positional; `--target <t>` / `--target=<t>` is optional
// (CLI wins over the PRX_COMPILE_TARGET env override).
let outfile: string | undefined;
let target = process.env.PRX_COMPILE_TARGET;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!; // bounded by argv.length
  if (arg === "--target") {
    target = argv[++i];
  } else if (arg.startsWith("--target=")) {
    target = arg.slice("--target=".length);
  } else if (outfile === undefined) {
    outfile = arg;
  } else {
    console.error(`prx-compile: unexpected argument '${arg}'`);
    process.exit(2);
  }
}
if (!outfile) {
  console.error("prx-compile: outfile required (usage: bun scripts/prx-compile.ts <outfile> [--target <t>])");
  process.exit(2);
}
if (target !== undefined && target.length === 0) {
  console.error("prx-compile: --target requires a value (e.g. bun-linux-arm64)");
  process.exit(2);
}

// rev-parse failures (shallow/no-git) collapse to '' — same as the old bash
// `|| echo ''`, so the BAKED_GIT_SHA define stays well-formed.
function gitShaShort(): string {
  const res = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

// prx-1ab: the release tag the build is cut from. On a release build
// `release-binary.yml` passes `PRX_COMPILE_VERSION=$GITHUB_REF_NAME` (the pushed
// `v*` tag); otherwise fall back to a tag sitting exactly on HEAD (a local
// `git tag` build) or '' for an untagged dev build, where the binary reports by
// git SHA instead.
function gitTagOnHead(): string {
  const res = spawnSync("git", ["tag", "--points-at", "HEAD", "--sort=-v:refname"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return "";
  return res.stdout.split("\n").map((l) => l.trim()).find((l) => /^v\d/.test(l)) ?? "";
}

const sha = process.env.PRX_COMPILE_GIT_SHA ?? gitShaShort();
const version = process.env.PRX_COMPILE_VERSION ?? gitTagOnHead();
const claudePath = process.env.PRX_COMPILE_CLAUDE_PATH ?? join(homedir(), ".local/bin/claude");

// Each --define value is a JS string literal — the inner quotes are literal
// characters in the replacement text, not shell quoting (spawnSync passes argv
// verbatim, no shell parsing).
const defines = [
  "--define", `__PRX_BUILD_GIT_SHA__="${sha}"`,
  "--define", `__PRX_BUILD_VERSION__="${version}"`,
  "--define", `__PRX_BUILD_CLAUDE_CODE_PATH__="${claudePath}"`,
];

const aiHomeRoot = process.env.PRX_COMPILE_AI_HOME_ROOT;
if (aiHomeRoot) {
  defines.push("--define", `__PRX_BUILD_AI_HOME_ROOT__="${aiHomeRoot}"`);
}

const bun = process.env.BUN ?? "bun";
const targetArgs = target ? [`--target=${target}`] : [];
const result = spawnSync(
  bun,
  ["build", "--compile", ...defines, ...targetArgs, "packages/prx/scripts/pr_state.ts", "--outfile", outfile],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
