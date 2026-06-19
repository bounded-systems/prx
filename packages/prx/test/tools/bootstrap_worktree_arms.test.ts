/**
 * bootstrap-worktree (GH-495) — the arms the fixture suite in
 * bootstrap_worktree.test.ts leaves uncovered: buildDefaultDeps + gitOutput,
 * the readDoltDatabaseName error arms (non-string / unparseable metadata), the
 * non-ENOENT redirect-read error, the no-repo-root contract skip, and the
 * formatBootstrapResult render branches (redirect target, staleState, schema).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapWorktree,
  buildDefaultDeps,
  formatBootstrapResult,
  type BootstrapDeps,
  type BootstrapResult,
} from "../../src/tools/bootstrap_worktree.ts";

function mkTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-arms-")));
}

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A feature-worktree fixture: a work dir with its own .beads pointing at a
 *  sibling main dir whose .beads is the canonical one. Deps are fully injected
 *  so no real git is consulted. */
function featureFixture(): { workDir: string; deps: BootstrapDeps } {
  const root = mkTmp();
  cleanups.push(root);
  const mainDir = join(root, "main");
  const workDir = join(root, "work");
  mkdirSync(join(mainDir, ".beads"), { recursive: true });
  mkdirSync(join(workDir, ".beads"), { recursive: true });
  const deps: BootstrapDeps = {
    resolveMainWorktree: () => mainDir,
    resolveRepoRoot: () => workDir,
    initContract: async () => ({}),
    repairBdSchema: null,
  };
  return { workDir, deps };
}

describe("buildDefaultDeps + gitOutput", () => {
  // Note: the gitOutput "exit != 0 → null" arm isn't exercised here — execGit
  // under bun test resolves against the test's own worktree rather than the
  // passed cwd (a cached-git-env harness quirk), so a tmpdir cwd still yields a
  // toplevel. The value arm below covers the trim/return path.
  test("wires the real path resolvers and bd-schema repair", () => {
    const deps = buildDefaultDeps(async () => ({}));
    expect(typeof deps.resolveMainWorktree).toBe("function");
    expect(deps.repairBdSchema).toBeTypeOf("function");
    // gitOutput value arm: a real repo cwd resolves to a non-empty toplevel.
    const root = deps.resolveRepoRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(root && root.length).toBeGreaterThan(0);
  });
});

describe("readDoltDatabaseName error arms (via detectStaleState)", () => {
  test("non-string dolt_database is treated as absent (dolt:false)", async () => {
    const { workDir, deps } = featureFixture();
    writeFileSync(join(workDir, ".beads", "metadata.json"), JSON.stringify({ dolt_database: 123 }));
    const r = await bootstrapWorktree(workDir, deps);
    expect(r.beads.status).toBe("wrote-redirect");
    expect(r.beads.staleState).toBeUndefined();
  });

  test("unparseable metadata.json is swallowed (dolt:false)", async () => {
    const { workDir, deps } = featureFixture();
    writeFileSync(join(workDir, ".beads", "metadata.json"), "{ not valid json");
    const r = await bootstrapWorktree(workDir, deps);
    expect(r.beads.status).toBe("wrote-redirect");
    expect(r.beads.staleState).toBeUndefined();
  });
});

describe("bootstrapBeads — non-ENOENT redirect read error", () => {
  test("a redirect that is a directory surfaces an error (EISDIR, not ENOENT)", async () => {
    const { workDir, deps } = featureFixture();
    // readFileSync on a directory throws EISDIR — the non-ENOENT arm.
    mkdirSync(join(workDir, ".beads", "redirect"), { recursive: true });
    const r = await bootstrapWorktree(workDir, deps);
    expect(r.beads.status).toBe("error");
    expect(r.exitCode).toBe(1);
    expect(r.beads.message).toBeTruthy();
  });
});

describe("bootstrapContract — no repo root", () => {
  test("skips with skipped-no-repo-root when resolveRepoRoot returns null", async () => {
    const cwd = mkTmp(); // no .beads → beads step skips; no repo root → contract skips
    cleanups.push(cwd);
    const deps: BootstrapDeps = {
      resolveMainWorktree: () => null,
      resolveRepoRoot: () => null,
      initContract: async () => ({}),
      repairBdSchema: null,
    };
    const r = await bootstrapWorktree(cwd, deps);
    expect(r.contract.status).toBe("skipped-no-repo-root");
    expect(r.contract.message).toContain("repo root");
  });
});

describe("formatBootstrapResult — plain render branches", () => {
  test("renders the redirect target, stale state, schema repair, and contract path", () => {
    const result: BootstrapResult = {
      beads: {
        status: "wrote-redirect",
        redirectPath: "/w/.beads/redirect",
        redirectTarget: "/m/.beads",
        staleState: { dolt: true, serverPid: true, serverPort: true, serverLock: true },
        schemaRepair: { status: "repaired", durationMs: 7, command: "bd stats --json" },
      },
      contract: { status: "wrote-contract", contractPath: "/w/.pr/local/pr.json" },
      exitCode: 0,
    };
    const plain = formatBootstrapResult(result, "plain");
    expect(plain).toContain("→ /m/.beads");
    expect(plain).toContain(
      "stale: dolt-data, dolt-server.pid, dolt-server.port, dolt-server.lock",
    );
    expect(plain).toContain("repair-redirect");
    expect(plain).toContain("bd-schema: repaired (7ms)");
    expect(plain).toContain("→ /w/.pr/local/pr.json");
  });
});
