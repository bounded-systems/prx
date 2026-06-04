import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binaryPath = join(repoRoot, "dist", "prx");

/**
 * Tests that exercise the compiled prx binary (dist/prx).
 *
 * Pure commands (version, help, model) run in a sandboxed temp git repo.
 * Session JSON contract tests live in test/pr-state/session_contract.test.ts
 * (injected context via deps, no binary needed).
 *
 * CI builds the binary before running tests.
 * Locally, run `bun run prx:build` first or these tests will be skipped.
 */

function hasBinary(): boolean {
  return existsSync(binaryPath);
}

function createSandbox(): string {
  const tmp = mkdtempSync(join(tmpdir(), "prx-sandbox-"));
  Bun.spawnSync({ cmd: ["git", "init", tmp], stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync({ cmd: ["git", "-C", tmp, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync({ cmd: ["git", "-C", tmp, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(tmp, "prx.toml"), '[worktree]\nmanager = "worktrunk"\n');
  Bun.spawnSync({ cmd: ["git", "-C", tmp, "add", "."], stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync({ cmd: ["git", "-C", tmp, "commit", "-m", "init"], stdout: "pipe", stderr: "pipe" });
  return tmp;
}

function run(
  args: string[],
  opts?: { cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [binaryPath, ...args],
    cwd: opts?.cwd ?? repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode ?? -1,
  };
}

describe("prx compiled binary", () => {
  let sandbox: string;

  beforeAll(() => {
    if (!hasBinary()) {
      console.warn(`Skipping binary tests: ${binaryPath} not found. Run 'bun run prx:build' first.`);
      return;
    }
    sandbox = createSandbox();
  });

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  // ── version (sandboxed) ──────────────────────────────────────────────

  describe("version", () => {
    test("--version prints a baked git SHA", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["--version"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/^git-[0-9a-f]{12}$/);
    });

    test("-v is an alias for --version", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["-v"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/^git-[0-9a-f]{12}$/);
    });

    test("version subcommand prints the same format", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["version"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/^git-[0-9a-f]{12}$/);
    });

    test("baked SHA is stable across invocations", () => {
      if (!hasBinary()) return;
      const first = run(["--version"], { cwd: sandbox }).stdout;
      const second = run(["--version"], { cwd: sandbox }).stdout;
      expect(first).toBe(second);
    });

    test("no update hint when sandbox has no origin/main", () => {
      if (!hasBinary()) return;
      const { stderr, exitCode } = run(["--version"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    });

    // prx-ktw: removed "update hint when behind origin/main" — `prx --version`
    // no longer reports local-checkout distance from origin/main; the only
    // update signal is the release-based binary check (covered in
    // cli.test.ts `checkPrxBinaryUpstream`).
  });

  // ── help (sandboxed) ─────────────────────────────────────────────────

  describe("help", () => {
    test("--help exits 0 and shows the registry-backed overview (GH-976)", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["--help"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("prx");
      expect(stdout).toContain("Primary workflow:");
      expect(stdout).toContain("prx plan session");
    });

    test("help-all lists full command catalog", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["help-all"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("full command catalog");
      expect(stdout).toContain("model");
      expect(stdout).toContain("chain");
      expect(stdout).toContain("contract");
    });

    test("session open --help prints session semantics", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["session", "open", "--help"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("prx session open");
      expect(stdout).toContain("--agent");
      expect(stdout).toContain("--dry-run");
      expect(stdout).toContain("--format");
    });
  });

  // ── model (sandboxed — pure, no external deps) ──────────────────────

  describe("model", () => {
    test("model show --format json returns machine definition", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["model", "show", "--format", "json"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("scope");
      expect(parsed).toHaveProperty("actors");
    });

    test("model actors --format json lists actor names", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["model", "actors", "--format", "json"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed.actors)).toBe(true);
      const names = parsed.actors.map((a: { actor: string }) => a.actor);
      expect(names).toContain("git");
      expect(names).toContain("gh");
    });

    test("model graph --format json returns state graph structure", () => {
      if (!hasBinary()) return;
      const { stdout, exitCode } = run(["model", "graph", "--format", "json"], { cwd: sandbox });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("type");
    });
  });
});
