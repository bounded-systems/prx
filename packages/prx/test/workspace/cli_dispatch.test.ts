/**
 * `prx workspace <verb>` dispatch coverage (GH-1978).
 *
 * The fixture-backed suites in `cli.test.ts` are guarded by
 * `skipIf(!GIT_COMMIT_AVAILABLE)` — they go dark wherever `git commit` needs a
 * signing agent that isn't reachable (the 1Password SSH agent locally, the
 * signing proxy in CI). That leaves `runWorkspaceCli`'s dispatch body,
 * `finalize`, `formatPlain`, and `resolveWorkspaceIdFromArgsOrCwd` uncovered in
 * exactly those environments.
 *
 * This suite closes that gap two ways that hold *everywhere*:
 *   - the cwd-cannot-resolve error arms run from a bare tmpdir (no commit, no
 *     git repo at all);
 *   - the happy paths use a fixture that disables commit/tag signing, so the
 *     actor runs end-to-end without any signing agent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parseWorkspaceArgs, runWorkspaceCli } from "../../src/workspace/cli.ts";

function sh(cwd: string, file: string, args: string[]): void {
  const r = spawnSync(file, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`${file} ${args.join(" ")} (cwd=${cwd}) exit=${r.status}\n${r.stderr ?? ""}`);
  }
}

/** A committable repo with signing disabled, so no signing agent is needed. */
function makeUnsignedRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync("/tmp/workspace-cli-dispatch-");
  sh(repoDir, "git", ["init", "-b", "main"]);
  sh(repoDir, "git", ["config", "user.email", "test@example.com"]);
  sh(repoDir, "git", ["config", "user.name", "Test"]);
  sh(repoDir, "git", ["config", "commit.gpgsign", "false"]);
  sh(repoDir, "git", ["config", "tag.gpgsign", "false"]);
  sh(repoDir, "git", ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]);
  writeFileSync(join(repoDir, "README"), "hello\n");
  sh(repoDir, "git", ["add", "README"]);
  sh(repoDir, "git", ["commit", "-m", "init"]);
  return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

// ── cwd-cannot-resolve error arms (no git repo needed) ──────────────────────

describe("runWorkspaceCli — cwd cannot resolve workspace_id", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync("/tmp/workspace-cli-norepo-");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Each verb that needs a workspace_id resolves it from the cwd; a bare,
  // non-git tmpdir yields null → the CLI throws before touching the actor.
  for (const argv of [
    ["materialize"],
    ["prepare", "--lifecycle", "materialized"],
    ["sync"],
    ["service", "--action", "start"],
    ["teardown"],
  ]) {
    test(`${argv[0]} throws when workspace_id is unresolvable`, () => {
      expect(() => runWorkspaceCli(parseWorkspaceArgs(argv), { cwd: dir })).toThrow(
        /cannot resolve workspace_id/,
      );
    });
  }
});

// ── argv validation arms that short-circuit before the actor ────────────────

describe("runWorkspaceCli — pre-actor validation", () => {
  const dir = "/tmp"; // never reached: these throw before resolving cwd
  test("reserve without --branch", () => {
    expect(() => runWorkspaceCli(parseWorkspaceArgs(["reserve"]), { cwd: dir })).toThrow(
      /reserve requires --branch/,
    );
  });
  test("prepare without --lifecycle", () => {
    expect(() => runWorkspaceCli(parseWorkspaceArgs(["prepare"]), { cwd: dir })).toThrow(
      /prepare requires --lifecycle/,
    );
  });
  test("service without --action", () => {
    expect(() => runWorkspaceCli(parseWorkspaceArgs(["service"]), { cwd: dir })).toThrow(
      /service requires --action/,
    );
  });
});

// ── full lifecycle against an unsigned fixture (runs everywhere) ────────────

describe("runWorkspaceCli — lifecycle (unsigned fixture)", () => {
  let fixture: ReturnType<typeof makeUnsignedRepo>;
  const cleanupPaths: string[] = [];
  beforeEach(() => {
    fixture = makeUnsignedRepo();
  });
  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true });
    fixture.cleanup();
  });

  test("reserve emits ReserveOutput JSON + exit 0", () => {
    const r = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", "main", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed.workspace_id).toMatch(/^[a-f0-9]{12}$/);
    expect(["exists-local", "exists-remote", "created", "skipped"]).toContain(parsed.status);
  });

  test("reserve plain format emits human-readable lines", () => {
    const r = runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), {
      cwd: fixture.repoDir,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("workspace.reserve:");
    expect(r.output).toContain("workspace_id=");
    expect(r.output).toContain("branch_ref=main");
  });

  test("reserve → prepare (default hydrate) → sync → teardown", () => {
    const reserve = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", "main", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(reserve.exitCode).toBe(0);
    const wid = (reserve.payload as { workspace_id: string }).workspace_id;

    // No hydrateBeads dep → exercises defaultHydrateBeads (no .beads ⇒ false).
    const prepare = runWorkspaceCli(
      parseWorkspaceArgs(["prepare", "--lifecycle", "materialized", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(prepare.exitCode).toBe(0);
    expect((prepare.payload as { workspace_id: string }).workspace_id).toBe(wid);

    const sync = runWorkspaceCli(parseWorkspaceArgs(["sync"]), { cwd: fixture.repoDir });
    expect(sync.exitCode).toBe(0);
    expect(sync.output).toContain("workspace.sync:");

    const teardown = runWorkspaceCli(parseWorkspaceArgs(["teardown", "--format", "json"]), {
      cwd: fixture.repoDir,
    });
    expect(teardown.exitCode).toBe(0);
    expect((teardown.payload as { status: string }).status).toBe("torn-down");
  });

  test("service --auto with no compose profile → no-profile + exit 0", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), {
      cwd: fixture.repoDir,
    });
    const r = runWorkspaceCli(
      parseWorkspaceArgs(["service", "--action", "start", "--auto", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(r.exitCode).toBe(0);
    expect((r.payload as { status: string }).status).toBe("no-profile");
  });

  test("materialize --workspace-id reuses the reserved id verbatim", () => {
    const branch = `wsmat-${fixture.repoDir.split("/").pop()}`;
    sh(fixture.repoDir, "git", ["branch", branch]);
    const reserve = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", branch, "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    const reservedId = (reserve.payload as { workspace_id: string }).workspace_id;

    // Passing the 12-hex id takes the `workspaceIdArg` fast-path in
    // resolveWorkspaceIdFromArgsOrCwd (no cwd context resolution).
    const materialize = runWorkspaceCli(
      parseWorkspaceArgs(["materialize", "--workspace-id", reservedId, "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(materialize.exitCode).toBe(0);
    const mat = materialize.payload as {
      workspace_id: string;
      worktree_path: string;
      status: string;
    };
    cleanupPaths.push(mat.worktree_path);
    expect(mat.workspace_id).toBe(reservedId);
    expect(["created", "exists"]).toContain(mat.status);
  }, 30000);

  test("materialize plain renders worktree_path; prepare attached uses default hydrate", () => {
    const branch = `wsplain-${fixture.repoDir.split("/").pop()}`;
    sh(fixture.repoDir, "git", ["branch", branch]);
    const reserve = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", branch, "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    const reservedId = (reserve.payload as { workspace_id: string }).workspace_id;

    // Plain materialize → formatPlain renders the worktree_path line.
    const mat = runWorkspaceCli(parseWorkspaceArgs(["materialize", "--workspace-id", reservedId]), {
      cwd: fixture.repoDir,
    });
    const matPayload = mat.payload as { worktree_path: string };
    cleanupPaths.push(matPayload.worktree_path);
    expect(mat.output).toContain("worktree_path=");

    // prepare against the now-materialized worktree with a non-`materialized`
    // lifecycle and no injected hydrate dep → exercises defaultHydrateBeads and
    // the plain beads_hydrated / files_written render branches.
    const prepare = runWorkspaceCli(
      parseWorkspaceArgs(["prepare", "--workspace-id", reservedId, "--lifecycle", "attached"]),
      { cwd: matPayload.worktree_path },
    );
    expect(prepare.output).toContain("workspace.prepare:");
    expect(prepare.output).toContain("beads_hydrated=");
  }, 30000);
});
