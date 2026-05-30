/**
 * Worktrunk config tests.
 *
 * Validates the worktrunk/config.toml shipped by the ai-home flake:
 * - No block_main hook (policy moved to prx)
 * - No user-specific paths
 * - XDG-aligned worktree-path using {{ repo }} template
 * - Nix module exists and references the config
 * - wt-wrapper script exists and derives path from WT_WORKTREE_PATH
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const pkgRoot = resolve(repoRoot, "packages", "prx");
const configPath = join(repoRoot, "worktrunk", "config.toml");
const nixModulePath = join(repoRoot, "nix", "home-manager", "worktrunk.nix");
const wrapperPath = join(pkgRoot, "scripts", "wt-wrapper.sh");
const flakePath = join(repoRoot, "flake.nix");

function readConfig(): string {
  return readFileSync(configPath, "utf8");
}

describe("worktrunk/config.toml", () => {
  test("config file exists", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  test("does not contain block_main hook", () => {
    const config = readConfig();
    expect(config).not.toContain("block_main");
    expect(config).not.toContain("block-main");
  });

  test("does not contain user-specific paths", () => {
    const config = readConfig();
    expect(config).not.toContain("/Users/");
    expect(config).not.toContain("/home/");
    expect(config).not.toContain("/nix/store/");
  });

  test("worktree-path uses {{ repo }} template variable", () => {
    const config = readConfig();
    expect(config).toContain("{{ repo }}");
    expect(config).toContain("{{ branch");
  });

  test("worktree-path is XDG_STATE_HOME-aligned under wt/worktrees", () => {
    const config = readConfig();
    expect(config).toContain("~/.local/state/wt/worktrees/{{ repo }}");
  });

  test("has no project-specific sections", () => {
    const config = readConfig();
    expect(config).not.toContain("[projects.");
  });

  test("has required hook sections", () => {
    const config = readConfig();
    expect(config).toContain("[pre-switch]");
    expect(config).toContain("[post-create]");
    expect(config).toContain("[post-switch]");
    expect(config).toContain("[post-remove]");
  });

  test("pre-switch contains prune and reserve only (no policy hooks, no .sh scripts)", () => {
    // GH-1978: `ensure-branch` collapsed into `prx workspace reserve` — the
    // workspace actor's `reserve` verb invokes the same `ensureBranch` helper
    // internally (src/workspace/actor.ts → src/tools/ensure_branch.ts).
    const config = readConfig();
    const lines = config.split("\n");
    const preSwitchIdx = lines.findIndex((l) => l.trim() === "[pre-switch]");
    expect(preSwitchIdx).toBeGreaterThan(-1);
    const entries: Array<{ key: string; value: string }> = [];
    for (let i = preSwitchIdx + 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.startsWith("[")) break;
      if (line.length === 0 || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      entries.push({
        key: line.slice(0, eq).trim(),
        value: line.slice(eq + 1).trim().replace(/^"|"$/g, ""),
      });
    }
    expect(entries.map((e) => e.key)).toEqual(["prune", "reserve"]);
    const reserve = entries.find((e) => e.key === "reserve");
    expect(reserve?.value).toBe("prx workspace reserve --branch {{ branch }}");
    for (const entry of entries) {
      expect(entry.value).not.toContain(".sh");
    }
    expect(config).not.toContain("block_main");
  });

  test("has commit generation command", () => {
    const config = readConfig();
    expect(config).toContain("[commit.generation]");
    expect(config).toContain("command =");
  });
});

describe("scripts/wt-wrapper.sh", () => {
  test("wrapper script exists", () => {
    expect(existsSync(wrapperPath)).toBe(true);
  });

  test("wrapper delegates to prx tools wt exec", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    expect(wrapper).toContain("prx tools wt exec");
  });

  test("wrapper passes parent PID", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    expect(wrapper).toContain("--parent-pid");
  });

  test("wrapper does not contain path templates or env resolution", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    // All path resolution moved to prx tools wt
    expect(wrapper).not.toContain("XDG_STATE_HOME");
    expect(wrapper).not.toContain("WORKTRUNK_WORKTREE_PATH");
    expect(wrapper).not.toContain("resolve_wt_bin");
  });
});

describe("nix/home-manager/worktrunk.nix", () => {
  test("module file exists", () => {
    expect(existsSync(nixModulePath)).toBe(true);
  });

  test("module defines single-source-of-truth path template", () => {
    const module = readFileSync(nixModulePath, "utf8");
    expect(module).toContain("wtWorktreePath");
    expect(module).toContain("wt/worktrees/{{ repo }}");
  });

  test("module defines programs.worktrunk option", () => {
    const module = readFileSync(nixModulePath, "utf8");
    expect(module).toContain("programs.worktrunk");
    expect(module).toContain("mkEnableOption");
  });

  test("module uses xdg.configFile for deployment", () => {
    const module = readFileSync(nixModulePath, "utf8");
    expect(module).toContain("xdg.configFile");
  });

  test("module exports WT_WORKTREE_PATH session variable", () => {
    const module = readFileSync(nixModulePath, "utf8");
    expect(module).toContain("WT_WORKTREE_PATH");
    expect(module).toContain("sessionVariables");
  });

  test("module builds wt wrapper from scripts/wt-wrapper.sh", () => {
    const module = readFileSync(nixModulePath, "utf8");
    expect(module).toContain("wt-wrapper.sh");
    expect(module).toContain("writeShellScriptBin");
  });

  test("config and wrapper use the same path template", () => {
    const module = readFileSync(nixModulePath, "utf8");
    // The nix module defines wtWorktreePath once and uses it for both
    // configFile and sessionVariables — verify the variable is used in both places
    expect(module).toContain("wtWorktreePath");
    const occurrences = module.split("wtWorktreePath").length - 1;
    // At least 3: definition + configFile usage + sessionVariables usage
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  test("inline pre-switch and post-create entries match worktrunk/config.toml (kept in sync)", () => {
    // GH-531: the inline config heredoc in worktrunk.nix and the checked-in
    // worktrunk/config.toml must ship the same pre-switch hooks. This test
    // guards against drift — if you add a key in one file, add it in both.
    // GH-495: extended to cover [post-create] since the bootstrap hook lives
    // there.
    const module = readFileSync(nixModulePath, "utf8");
    const tomlConfig = readConfig();

    function extractSectionEntries(text: string, section: string): Array<{ key: string; value: string }> {
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => l.trim() === `[${section}]`);
      if (idx === -1) return [];
      const entries: Array<{ key: string; value: string }> = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line.startsWith("[")) break;
        if (line.length === 0 || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        entries.push({
          key: line.slice(0, eq).trim(),
          value: line.slice(eq + 1).trim().replace(/^"|"$/g, ""),
        });
      }
      return entries;
    }

    const tomlPreSwitch = extractSectionEntries(tomlConfig, "pre-switch");
    const nixPreSwitch = extractSectionEntries(module, "pre-switch");
    expect(nixPreSwitch).toEqual(tomlPreSwitch);
    // GH-1978: pre-switch.reserve replaces the prior `ensure-branch` entry.
    expect(nixPreSwitch.some((e) => e.key === "reserve" && e.value === "prx workspace reserve --branch {{ branch }}"))
      .toBe(true);

    const tomlPostCreate = extractSectionEntries(tomlConfig, "post-create");
    const nixPostCreate = extractSectionEntries(module, "post-create");
    expect(nixPostCreate).toEqual(tomlPostCreate);
    expect(nixPostCreate.some((e) => e.key === "bootstrap" && e.value === "prx tools wt bootstrap"))
      .toBe(true);
  });

  test("no hook calls wtctl (GH-1978: retired in favor of `prx workspace`)", () => {
    // GH-1978: the workspace actor (src/workspace/actor.ts) is the home
    // for the four verbs wtctl used to own (sync, ignore sync, up --auto,
    // down --auto). Drivers — worktrunk is the only one today — call
    // into it through `prx workspace <verb>`. This guard prevents
    // accidental regression to wtctl in either source of truth.
    const config = readConfig();
    const module = readFileSync(nixModulePath, "utf8");
    expect(config).not.toContain("wtctl");
    expect(module).not.toContain("wtctl");
  });
});

describe("flake.nix", () => {
  test("exports worktrunk module", () => {
    const flake = readFileSync(flakePath, "utf8");
    expect(flake).toContain("worktrunk");
    expect(flake).toContain("./nix/home-manager/worktrunk.nix");
  });

  test("default module includes worktrunk", () => {
    const flake = readFileSync(flakePath, "utf8");
    expect(flake).toContain("self.homeManagerModules.worktrunk");
  });
});
