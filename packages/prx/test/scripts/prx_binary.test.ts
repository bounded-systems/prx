import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

// Repo root is four levels up from this file (test/scripts/ → packages/prx/
// → packages/ → root). The compiled binary lands at repo-root dist/prx — both
// `bun run prx:build` and ci.yml emit there — so binaryPath must resolve to
// the root, not packages/prx. (Previously "../.." pointed at packages/prx,
// where no binary ever exists, so every test here silently self-skipped.)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
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
  Bun.spawnSync({
    cmd: ["git", "-C", tmp, "config", "user.name", "test"],
    stdout: "pipe",
    stderr: "pipe",
  });
  Bun.spawnSync({
    cmd: ["git", "-C", tmp, "config", "user.email", "test@test"],
    stdout: "pipe",
    stderr: "pipe",
  });
  writeFileSync(join(tmp, "prx.toml"), '[worktree]\nmanager = "worktrunk"\n');
  Bun.spawnSync({ cmd: ["git", "-C", tmp, "add", "."], stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync({
    cmd: ["git", "-C", tmp, "commit", "-m", "init"],
    stdout: "pipe",
    stderr: "pipe",
  });
  return tmp;
}

function run(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [binaryPath, ...args],
    cwd: opts?.cwd ?? repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env ?? process.env,
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
      console.warn(
        `Skipping binary tests: ${binaryPath} not found. Run 'bun run prx:build' first.`,
      );
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

    // `prx session` was retired (GH-1530 → canonical `prx plan session`). This
    // test was silently self-skipping (the binary-path bug fixed alongside
    // prx-eky), so it still asserted the old surface; pin the retirement redirect.
    test("session open is retired and redirects to plan session", () => {
      if (!hasBinary()) return;
      const { stderr, exitCode } = run(["session", "open", "--help"], { cwd: sandbox });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("retired");
      expect(stderr).toContain("prx plan session");
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

  // ── audit DB embedded schema (prx-eky) ───────────────────────────────
  //
  // The compiled binary applies its SQLite DDL from schema.sql on first DB
  // open. If that asset is not embedded into the --compile bundle, every
  // audit-DB command ENOENTs on `/$bunfs/root/schema.sql`. `audit system`
  // lazily creates the DB and applies the schema, so it exercises the embed
  // with no ingest and no network. XDG_STATE_HOME points the DB at a temp
  // dir so the smoke test never touches the dev machine's real metrics store.
  describe("audit DB embedded schema (prx-eky)", () => {
    test("audit system opens the DB without ENOENT schema.sql", () => {
      if (!hasBinary()) return;
      const stateDir = mkdtempSync(join(tmpdir(), "prx-audit-state-"));
      try {
        const { stdout, stderr, exitCode } = run(["audit", "system", "--format", "json"], {
          cwd: sandbox,
          env: { ...process.env, XDG_STATE_HOME: stateDir },
        });
        expect(stderr).not.toContain("schema.sql");
        expect(stderr).not.toContain("ENOENT");
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed).toHaveProperty("metrics");
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});
