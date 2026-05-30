/**
 * Lifecycle chain parity tests — GH-419.
 *
 * Tests the structural invariants of the full chain:
 *   issue → remote branch → local branch → worktree → working dir → agent session
 *
 * The GH-419 bug: worktree created at wt/worktrees/ but config.toml said
 * git/worktrees/, so wt list didn't see it. Board got artifacts.worktree=false,
 * parity chain fired spurious create_worktree, session open blocked.
 *
 * Integration tests with buildParityChain are in test/pr-state/github.test.ts.
 * These tests verify the config-level invariants that prevent the divergence.
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
const pkgRoot = resolve(repoRoot, "packages", "prx");
const configPath = join(repoRoot, "worktrunk", "config.toml");
const nixModulePath = join(repoRoot, "nix", "home-manager", "worktrunk.nix");

describe("lifecycle chain: config parity prevents GH-419", () => {
  /**
   * The root cause of GH-419: config.toml said git/worktrees/ while the
   * wrapper used wt/worktrees/. When wt switch creates a worktree, it uses
   * the WORKTRUNK_WORKTREE_PATH env var (set by the wrapper). But wt list
   * reads config.toml to know where to look. If these disagree, wt list
   * can't find the worktree → board says artifacts.worktree=false →
   * parity chain fires create_worktree → session open blocks.
   */

  test.skipIf(!existsSync(configPath))("config.toml path matches prx tools wt resolved path (same subdirectory)", () => {
    const config = readFileSync(configPath, "utf8");
    const match = config.match(/worktree-path\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const configTemplate = match![1]!;

    const resolved = resolveWorktreePath({ HOME: "/home/test" });

    // Extract subdirectory from each (between ~/.local/state/ and {{ repo }})
    const configSubdir = configTemplate.match(/\.local\/state\/([^{]+)\//)?.[1];
    const resolvedSubdir = resolved.template.match(/\.local\/state\/([^{]+)\//)?.[1];

    expect(configSubdir).toBe(resolvedSubdir);
    expect(configSubdir).toBe(WT_SUBDIRECTORY);
  });

  test("WORKTRUNK_WORKTREE_PATH equals WT_WORKTREE_PATH (no divergence possible)", () => {
    const env = worktreeEnv({ HOME: "/home/test" });
    expect(env.vars.WT_WORKTREE_PATH).toBe(env.vars.WORKTRUNK_WORKTREE_PATH);
  });

  test.skipIf(!existsSync(nixModulePath))("nix module is the single source of truth (defines once, used for config + env)", () => {
    const nixModule = readFileSync(nixModulePath, "utf8");

    // wtWorktreePath is defined once and referenced in configFile and sessionVariables
    const defMatch = nixModule.match(/wtWorktreePath\s*=\s*"([^"]+)"/);
    expect(defMatch).not.toBeNull();

    const nixTemplate = defMatch![1];
    expect(nixTemplate).toContain(WT_SUBDIRECTORY);
    expect(nixTemplate).toContain(TEMPLATE_SUFFIX);

    // Config template uses nix interpolation: worktree-path = "${wtWorktreePath}"
    expect(nixModule).toContain('worktree-path = "${wtWorktreePath}"');

    // Same template is exported as WT_WORKTREE_PATH session variable
    expect(nixModule).toContain("WT_WORKTREE_PATH = wtWorktreePath");
  });
});

describe("lifecycle chain: worktree → working dir parity", () => {
  test("worktree base dir and state root share XDG_STATE_HOME", () => {
    const env = worktreeEnv({ XDG_STATE_HOME: "/custom/state", HOME: "/h" });
    const path = resolveWorktreePath({ XDG_STATE_HOME: "/custom/state", HOME: "/h" });

    // The worktree base must be under WT_STATE_ROOT
    expect(path.base).toStartWith(env.vars.WT_STATE_ROOT!);
  });

  test("directive spool dir lives under same state root as worktrees", () => {
    const env = worktreeEnv({ HOME: "/home/test" });

    // Directives go to ${WT_STATE_ROOT}/wt/directives/
    // Worktrees go to ${WT_STATE_ROOT}/wt/worktrees/
    // Both must be under the same state root
    const stateRoot = env.vars.WT_STATE_ROOT!;
    const worktreeBase = resolveWorktreePath({ HOME: "/home/test" }).base;

    expect(worktreeBase).toStartWith(stateRoot);
    // Both use the /wt/ subdirectory under state root
    expect(worktreeBase).toContain(`${stateRoot}/wt/`);
  });
});

describe("lifecycle chain: no divergent path bases", () => {
  test.skipIf(!existsSync(configPath))("neither config.toml nor prx tools wt use the old git/worktrees base", () => {
    const config = readFileSync(configPath, "utf8");
    const resolved = resolveWorktreePath({ HOME: "/home/test" });

    expect(config).not.toContain("/git/worktrees/{{ repo }}");
    expect(resolved.template).not.toContain("/git/worktrees/");
  });

  test("wrapper script does not define its own path template", () => {
    const wrapperPath = join(pkgRoot, "scripts", "wt-wrapper.sh");
    const wrapper = readFileSync(wrapperPath, "utf8");

    // Wrapper should delegate to prx tools wt, not compute paths
    expect(wrapper).toContain("prx tools wt exec");
    expect(wrapper).not.toContain("WORKTRUNK_WORKTREE_PATH");
    expect(wrapper).not.toContain("XDG_STATE_HOME");
  });

  test("all XDG_STATE_HOME references resolve to the same default", () => {
    // Without explicit XDG_STATE_HOME, everything falls back to ~/.local/state
    const envDefault = worktreeEnv({ HOME: "/home/test" });
    const pathDefault = resolveWorktreePath({ HOME: "/home/test" });

    expect(envDefault.vars.WT_STATE_ROOT).toBe("/home/test/.local/state");
    expect(pathDefault.xdgStateHome).toBe("/home/test/.local/state");
    expect(pathDefault.base).toBe("/home/test/.local/state/wt/worktrees");
  });
});
