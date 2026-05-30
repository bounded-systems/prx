import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * M2.5 (functional-ripple, GH-696): enforce "no python in this repo" — zero, no
 * exemptions.
 *
 * The M2 ports replaced every operational python script with TypeScript; the
 * vendored .system meta-skills were removed; and the prx-sandbox spike python
 * was removed (that experiment moves to @bounded-systems/sandbox — ai-home-8hcxw;
 * preserved in git history). Python is removed as a dependency and denied in
 * agent tooling (claude/settings.json, claude/worktree-settings.json).
 *
 * Implemented as a bun test (not a nix flake check) because flake.nix exposes
 * only homeManagerModules — no checks/nixpkgs infrastructure — and this runs in
 * the existing `prx ci` / `bun test` phase. git ls-files excludes gitignored
 * paths (node_modules).
 */
describe("no python (M2 functional-ripple)", () => {
  test("the tracked tree contains no *.py files", () => {
    const r = spawnSync("git", ["-C", repoRoot, "ls-files", "*.py"], { encoding: "utf8" });
    expect(r.status, r.stderr ?? "").toBe(0);
    const pyFiles = (r.stdout ?? "").split("\n").filter(Boolean);
    expect(pyFiles, `python files must not exist in this repo:\n${pyFiles.join("\n")}`).toEqual([]);
  });
});
