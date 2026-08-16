import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Path to the per-repo override that ai-home ships under
// .prx/repos/io.github/bdelanghe/ai-home/hooks/pre-commit (GH-1124).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOOK_SCRIPT = join(
  repoRoot,
  ".prx",
  "repos",
  "io.github",
  "bdelanghe",
  "ai-home",
  "hooks",
  "pre-commit",
);

type Fixture = {
  root: string;
  work: string;
  hook: string;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-secret-scan-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });

  spawnSync("git", ["init", "--initial-branch=main", work]);
  spawnSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", work, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", work, "config", "commit.gpgsign", "false"]);

  // Copy the override script into a stable path inside the fixture so the
  // test exercises the exact script ai-home ships, not a transformed copy.
  const hook = join(root, "pre-commit");
  copyFileSync(HOOK_SCRIPT, hook);
  spawnSync("chmod", ["755", hook]);

  return { root, work, hook };
}

function stageBeadsConfig(work: string, contents: string) {
  const beadsDir = join(work, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  writeFileSync(join(beadsDir, "config.yaml"), contents);
  spawnSync("git", ["-C", work, "add", ".beads/config.yaml"]);
}

function runHook(work: string, hook: string) {
  return spawnSync(hook, [], { cwd: work, encoding: "utf8" });
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

// The pre-commit override now lives in the per-operator `.prx/repos/` registry,
// which is local-materialized state (gitignored — see public-repo hygiene). When
// the override isn't present (CI / fresh clones), skip; re-homing this scan as a
// prx built-in hook is tracked separately so the public repo keeps secret-scanning.
describe.skipIf(!existsSync(HOOK_SCRIPT))(
  "ai-home per-repo pre-commit secret scan (GH-1124)",
  () => {
    test("blocks staged gho_* token in .beads/config.yaml", () => {
      stageBeadsConfig(fx.work, "github:\n  token: gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n");
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("op://");
      expect(result.stderr).toContain(".beads/config.yaml");
      expect(result.stderr).toContain("gho_***");
      // The full token must NOT be echoed back (avoid leaking into terminal
      // scrollback / CI logs).
      expect(result.stderr).not.toContain("FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE");
    });

    test("blocks staged ghp_* token in .beads/config.yaml", () => {
      stageBeadsConfig(fx.work, "github:\n  token: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n");
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ghp_***");
      expect(result.stderr).toContain("op://");
    });

    test("blocks staged github_pat_* token in .beads/config.yaml", () => {
      stageBeadsConfig(fx.work, "github:\n  token: github_pat_11ABCDE_FAKEFAKEFAKEFAKEFAKEFAKE\n");
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("github_pat_***");
      expect(result.stderr).toContain("op://");
    });

    test("blocks even when working tree is reverted but index still holds the token", () => {
      // The 2026-04-30 case: file looks clean on disk, but the index entry
      // is what gets committed. `git show :path` reads the index, not HEAD.
      stageBeadsConfig(fx.work, "github:\n  token: gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n");
      // Wipe the working-tree copy so only the index has the secret.
      writeFileSync(join(fx.work, ".beads", "config.yaml"), "github:\n  token: ''\n");

      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("gho_***");
    });

    test("allows benign .beads/config.yaml (no token-shaped value)", () => {
      stageBeadsConfig(fx.work, "issue-prefix: ai-home\nno-db: false\n");
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    test("allows token-shaped string outside .beads/ (out of scope by design)", () => {
      // Broader secret scanning is GH-1117 territory. This hook is a targeted
      // defensive guard for the bd v1.0.3 footgun, not a full gitleaks.
      writeFileSync(
        join(fx.work, "README.md"),
        "Example token shape: gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n",
      );
      spawnSync("git", ["-C", fx.work, "add", "README.md"]);
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(0);
    });

    test("no staged .beads/ files → exits 0 silently", () => {
      writeFileSync(join(fx.work, "README.md"), "hello\n");
      spawnSync("git", ["-C", fx.work, "add", "README.md"]);
      const result = runHook(fx.work, fx.hook);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  },
);
