/**
 * Worktree path parity tests — GH-419.
 *
 * Validates that the worktree path template is consistent across:
 *   1. prx tools wt (TypeScript single source of truth)
 *   2. worktrunk/config.toml (deployed config)
 *   3. nix module (generates both)
 *   4. board status / parity chain (worktree detection)
 *
 * The core bug: config.toml said git/worktrees/ while wt-wrapper used
 * wt/worktrees/, causing prx chain status to report "no worktree" for
 * worktrees that git sees. This made session open fail in a catch-22.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  resolveWorktreePath,
  worktreeEnv,
  WT_SUBDIRECTORY,
  TEMPLATE_SUFFIX,
} from "../../src/tools/worktree_path.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const configPath = join(repoRoot, "worktrunk", "config.toml");
const nixModulePath = join(repoRoot, "nix", "home-manager", "worktrunk.nix");

describe("GH-419: path template parity", () => {
  test.skipIf(!existsSync(configPath))("config.toml and prx tools wt use the same base path", () => {
    const config = readFileSync(configPath, "utf8");
    const result = resolveWorktreePath({ HOME: "/home/test" });

    // Extract the path template from config.toml
    const match = config.match(/worktree-path\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const configTemplate = match![1];

    // Both must use wt/worktrees as the subdirectory
    expect(configTemplate).toContain(`/${WT_SUBDIRECTORY}/`);
    expect(result.template).toContain(`/${WT_SUBDIRECTORY}/`);

    // Neither should use the old git/worktrees path
    expect(configTemplate).not.toContain("/git/worktrees/");
    expect(result.template).not.toContain("/git/worktrees/");
  });

  test.skipIf(!existsSync(configPath))("config.toml and prx tools wt use the same template suffix", () => {
    const config = readFileSync(configPath, "utf8");
    const match = config.match(/worktree-path\s*=\s*"([^"]+)"/);
    const configTemplate = match![1];

    // Both must end with the same {{ repo }}/{{ branch }} pattern
    expect(configTemplate).toContain(TEMPLATE_SUFFIX);
  });

  test.skipIf(!existsSync(nixModulePath) || !existsSync(configPath))("nix module defines the template that matches config.toml suffix", () => {
    const nixModule = readFileSync(nixModulePath, "utf8");
    const config = readFileSync(configPath, "utf8");

    const configMatch = config.match(/worktree-path\s*=\s*"([^"]+)"/);
    const configTemplate = configMatch![1];

    // config.toml uses ~ while nix uses ${config.home.homeDirectory}
    // Both must share the same path suffix after the home directory
    const suffix = ".local/state/wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}";
    expect(configTemplate).toContain(suffix);
    expect(nixModule).toContain(suffix);
  });

  test.skipIf(!existsSync(nixModulePath))("nix module uses wtWorktreePath in both configFile and sessionVariables", () => {
    const nixModule = readFileSync(nixModulePath, "utf8");

    // wtWorktreePath should appear in:
    // 1. its definition
    // 2. the configFile template
    // 3. the sessionVariables export
    const occurrences = nixModule.split("wtWorktreePath").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  test("WT_WORKTREE_PATH env always equals WORKTRUNK_WORKTREE_PATH", () => {
    const envs = [
      { HOME: "/home/test" },
      { XDG_STATE_HOME: "/custom/state", HOME: "/home/test" },
      { WT_WORKTREE_PATH: "/explicit/{{ repo }}/{{ branch | sanitize_db }}", HOME: "/h" },
    ];
    for (const env of envs) {
      const result = worktreeEnv(env);
      expect(result.vars.WT_WORKTREE_PATH).toBe(result.vars.WORKTRUNK_WORKTREE_PATH);
    }
  });
});

describe("GH-419: worktree vs working directory parity", () => {
  test("worktreeEnv includes WT_STATE_ROOT for directive spool path", () => {
    const result = worktreeEnv({ HOME: "/home/test" });
    expect(result.vars.WT_STATE_ROOT).toBeDefined();
    // State root should be the XDG_STATE_HOME, not a different base
    expect(result.vars.WT_STATE_ROOT).toBe("/home/test/.local/state");
  });

  test("worktree base and state root share the same XDG_STATE_HOME", () => {
    const path = resolveWorktreePath({ XDG_STATE_HOME: "/custom/state", HOME: "/h" });
    const env = worktreeEnv({ XDG_STATE_HOME: "/custom/state", HOME: "/h" });

    // The worktree base should be under the same state root
    expect(path.base).toStartWith(env.vars.WT_STATE_ROOT!);
    expect(path.base).toBe(`${env.vars.WT_STATE_ROOT}/${WT_SUBDIRECTORY}`);
  });

  test("worktree path template includes repo and branch placeholders", () => {
    const result = resolveWorktreePath({ HOME: "/home/test" });

    // These placeholders are what worktrunk uses to create the actual directory
    expect(result.template).toContain("{{ repo }}");
    expect(result.template).toContain("{{ branch | sanitize_db }}");
  });

  test("default worktree path matches where wt actually creates worktrees", () => {
    // The canonical production path that wt switch creates:
    //   ~/.local/state/wt/worktrees/<repo>/<sanitized-branch>
    const result = resolveWorktreePath({ HOME: "/Users/dev" });
    expect(result.base).toBe("/Users/dev/.local/state/wt/worktrees");
  });
});

describe("GH-419: session open backfill detection", () => {
  test.skipIf(!existsSync(configPath))("board unit with worktree_path set has artifacts.worktree=true", () => {
    // When wt list returns a worktree, the board unit gets worktree_path set
    // and artifacts.worktree=true. This means the parity chain won't
    // generate a create_worktree action.
    //
    // The bug: if wt list doesn't see the worktree (because the path template
    // in config.toml doesn't match), the unit comes from PRs instead,
    // with artifacts.worktree=false and worktree_path=null.
    // This triggers a spurious create_worktree backfill action.
    //
    // This is a structural assertion — the actual integration test would
    // require mocking wt list output. See github.test.ts for those.

    // Verify the fix: config.toml now uses wt/worktrees (same as wt switch)
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("wt/worktrees/{{ repo }}");
    expect(config).not.toContain("git/worktrees/{{ repo }}");
  });

  test.skipIf(!existsSync(nixModulePath))("parity chain create_worktree uses configured worktree manager command", () => {
    // The command in the parity action should match the configured manager.
    // If the path template is wrong, the command would create a worktree
    // at a different location than where wt switch would put it.
    //
    // By unifying the template, both wt switch and prx chain backfill
    // will target the same directory.
    const nixModule = readFileSync(nixModulePath, "utf8");
    expect(nixModule).toContain("wtWorktreePath");

    // The nix module builds the wrapper from the same source
    expect(nixModule).toContain("wt-wrapper.sh");
    expect(nixModule).toContain("writeShellScriptBin");
  });
});
