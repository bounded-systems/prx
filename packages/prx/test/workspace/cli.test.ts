/**
 * `prx workspace <verb>` CLI surface (GH-1978).
 *
 * Exercises the argv parser and the dispatch wiring against the
 * workspace actor. The fixture pattern mirrors `test/workspace/actor.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parseWorkspaceArgs, runWorkspaceCli, WorkspaceCliError } from "../../src/workspace/cli.ts";
import { materializeWorkUnitBranch, normalizeNamespaceArgv } from "../../src/pr-state/cli.ts";

function sh(cwd: string, file: string, args: string[]): void {
  const r = spawnSync(file, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`${file} ${args.join(" ")} (cwd=${cwd}) exit=${r.status}\n${r.stderr ?? ""}`);
  }
}

function makeFixtureRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync("/tmp/workspace-cli-");
  sh(repoDir, "git", ["init", "-b", "main"]);
  sh(repoDir, "git", ["config", "user.email", "test@example.com"]);
  sh(repoDir, "git", ["config", "user.name", "Test"]);
  // Signing off: without it a host with `commit.gpgsign=true` (e.g. SSH
  // signing) hangs this fixture's commit on a signing prompt (#280).
  sh(repoDir, "git", ["config", "commit.gpgsign", "false"]);
  sh(repoDir, "git", ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]);
  writeFileSync(join(repoDir, "README"), "hello\n");
  sh(repoDir, "git", ["add", "README"]);
  sh(repoDir, "git", ["commit", "-m", "init"]);
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

// Quarantine guard: the fixture commits via `git commit`, which fails when the
// environment's commit-signing is unavailable (the CI signing proxy returns
// HTTP 400 "missing source"). Probe once and skip the fixture-backed describes
// when committing isn't possible, so signing infra can't block CI. The tests
// still run wherever `git commit` works.
function gitCommitAvailable(): boolean {
  let dir: string | null = null;
  try {
    dir = mkdtempSync("/tmp/ws-signing-probe-");
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "probe@example.com"],
      ["config", "user.name", "Probe"],
      // Must mirror makeFixtureRepo's signing config, or this probe reports
      // "cannot commit" for a fixture that would now build fine (#280).
      ["config", "commit.gpgsign", "false"],
      ["commit", "--allow-empty", "-m", "probe"],
    ]) {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if ((r.status ?? 1) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
const GIT_COMMIT_AVAILABLE = gitCommitAvailable();

describe("parseWorkspaceArgs", () => {
  test("rejects empty argv", () => {
    expect(() => parseWorkspaceArgs([])).toThrow(WorkspaceCliError);
  });

  test("rejects unknown verb", () => {
    expect(() => parseWorkspaceArgs(["destroy"])).toThrow(WorkspaceCliError);
  });

  test("reserve --branch X --base Y", () => {
    const args = parseWorkspaceArgs(["reserve", "--branch", "GH-1978", "--base", "origin/release"]);
    expect(args).toEqual({
      verb: "reserve",
      format: "plain",
      workspaceId: undefined,
      branch: "GH-1978",
      base: "origin/release",
      lifecycle: undefined,
      action: undefined,
      auto: false,
      force: false,
    });
  });

  test("prepare --lifecycle materialized --format json", () => {
    const args = parseWorkspaceArgs(["prepare", "--lifecycle", "materialized", "--format", "json"]);
    expect(args.verb).toBe("prepare");
    expect(args.lifecycle).toBe("materialized");
    expect(args.format).toBe("json");
  });

  test("materialize parses --workspace-id (and --branch resolution carries through)", () => {
    const args = parseWorkspaceArgs(["materialize", "--workspace-id", "abcdef012345"]);
    expect(args.verb).toBe("materialize");
    expect(args.workspaceId).toBe("abcdef012345");
  });

  test("prx-997: `prx workspace materialize` is wired into the CLI dispatch", () => {
    // Regression: `materialize` exists in WORKSPACE_VERBS + runWorkspaceCli but
    // was missing from the `prx workspace <verb>` router allow-list, so the verb
    // was unreachable. The full lifecycle (reserve → materialize → prepare → …)
    // is now routable.
    expect(
      normalizeNamespaceArgv(["workspace", "materialize", "--workspace-id", "abcdef012345"]),
    ).toEqual(["workspace", "materialize", "--workspace-id", "abcdef012345"]);
    expect(() => normalizeNamespaceArgv(["workspace", "bogus"])).toThrow(
      /Unknown workspace subcommand: bogus/,
    );
  });

  test("service --action start --auto", () => {
    const args = parseWorkspaceArgs(["service", "--action", "start", "--auto"]);
    expect(args.action).toBe("start");
    expect(args.auto).toBe(true);
  });

  test("teardown --force", () => {
    const args = parseWorkspaceArgs(["teardown", "--force"]);
    expect(args.verb).toBe("teardown");
    expect(args.force).toBe(true);
  });
});

describe.skipIf(!GIT_COMMIT_AVAILABLE)("runWorkspaceCli — happy paths", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("reserve emits ReserveOutput-shaped JSON", () => {
    const result = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", "main", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.workspace_id).toMatch(/^[a-f0-9]{12}$/);
    expect(parsed.branch_ref).toBe("main");
    expect(["exists-local", "exists-remote", "created", "skipped"]).toContain(parsed.status);
  });

  test("end-to-end reserve → prepare → sync → teardown", () => {
    const reserve = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", "main", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(reserve.exitCode).toBe(0);
    const wid = (reserve.payload as { workspace_id: string }).workspace_id;

    const prepare = runWorkspaceCli(
      parseWorkspaceArgs(["prepare", "--lifecycle", "materialized", "--format", "json"]),
      { cwd: fixture.repoDir, hydrateBeads: () => false },
    );
    expect(prepare.exitCode).toBe(0);
    expect((prepare.payload as { workspace_id: string }).workspace_id).toBe(wid);

    const sync = runWorkspaceCli(parseWorkspaceArgs(["sync", "--format", "json"]), {
      cwd: fixture.repoDir,
    });
    expect(sync.exitCode).toBe(0);
    expect((sync.payload as { workspace_id: string }).workspace_id).toBe(wid);

    const teardown = runWorkspaceCli(parseWorkspaceArgs(["teardown", "--format", "json"]), {
      cwd: fixture.repoDir,
    });
    expect(teardown.exitCode).toBe(0);
    expect((teardown.payload as { status: string }).status).toBe("torn-down");
  });

  test("service --auto with no compose yields no-profile + exit 0", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main", "--format", "json"]), {
      cwd: fixture.repoDir,
    });
    const result = runWorkspaceCli(
      parseWorkspaceArgs(["service", "--action", "start", "--auto", "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(result.exitCode).toBe(0);
    expect((result.payload as { status: string }).status).toBe("no-profile");
  });

  test("plain format emits human-readable lines", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), { cwd: fixture.repoDir });
    const result = runWorkspaceCli(parseWorkspaceArgs(["sync"]), { cwd: fixture.repoDir });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("workspace.sync");
    expect(result.output).toContain("workspace_id=");
  });
});

describe.skipIf(!GIT_COMMIT_AVAILABLE)("runWorkspaceCli — I-WS1 gate (no prior reserve)", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("prepare exits non-zero when no reserve happened", () => {
    const result = runWorkspaceCli(parseWorkspaceArgs(["prepare", "--lifecycle", "materialized"]), {
      cwd: fixture.repoDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no prior reserve");
  });

  test("sync exits non-zero when no reserve happened", () => {
    const result = runWorkspaceCli(parseWorkspaceArgs(["sync"]), { cwd: fixture.repoDir });
    expect(result.exitCode).toBe(1);
  });

  test("teardown without --force exits non-zero when no ledger", () => {
    const result = runWorkspaceCli(parseWorkspaceArgs(["teardown"]), { cwd: fixture.repoDir });
    expect(result.exitCode).toBe(1);
  });
});

describe.skipIf(!GIT_COMMIT_AVAILABLE)("runWorkspaceCli — materialize --branch (GH-2280)", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  const cleanupPaths: string[] = [];
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
    fixture.cleanup();
  });

  // GH-2280 Target 3: a non-session caller who reserves `--branch X` from a
  // cwd whose HEAD is a *different* branch (here `main`) must be able to
  // materialize the same workspace by passing the same `--branch X`. Without
  // the flag, materialize derives its workspace_id from the cwd HEAD (`main`),
  // misses the ledger reserve wrote under (slug, X), and fails closed.
  test("materialize --branch resolves the same workspace_id reserve minted", () => {
    const branch = `wsmat-${fixture.repoDir.split("/").pop()}`;
    // Pre-create the branch locally so reserve resolves `exists-local` and
    // never reaches the network push leg (offline fixture).
    sh(fixture.repoDir, "git", ["branch", branch]);

    const reserve = runWorkspaceCli(
      parseWorkspaceArgs(["reserve", "--branch", branch, "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(reserve.exitCode).toBe(0);
    const reservedId = (reserve.payload as { workspace_id: string }).workspace_id;
    expect(reservedId).toMatch(/^[a-f0-9]{12}$/);

    const materialize = runWorkspaceCli(
      parseWorkspaceArgs(["materialize", "--branch", branch, "--format", "json"]),
      { cwd: fixture.repoDir },
    );
    expect(materialize.exitCode).toBe(0);
    const mat = materialize.payload as {
      workspace_id: string;
      worktree_path: string;
      branch: string;
      status: string;
    };
    cleanupPaths.push(mat.worktree_path);
    // The flag makes the two ids agree — the gap GH-2280 closes.
    expect(mat.workspace_id).toBe(reservedId);
    expect(mat.branch).toBe(branch);
    expect(["created", "exists"]).toContain(mat.status);
  }, 30000);

  test("materialize without --branch from a different HEAD misses the reserve (the gap)", () => {
    const branch = `wsmat2-${fixture.repoDir.split("/").pop()}`;
    sh(fixture.repoDir, "git", ["branch", branch]);
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", branch, "--format", "json"]), {
      cwd: fixture.repoDir,
    });

    // cwd HEAD is still `main`; without --branch the cwd-derived id is for
    // (slug, main), which has no reserve ledger → fails closed.
    const materialize = runWorkspaceCli(parseWorkspaceArgs(["materialize", "--format", "json"]), {
      cwd: fixture.repoDir,
    });
    expect(materialize.exitCode).toBe(1);
  }, 30000);
});

describe.skipIf(!GIT_COMMIT_AVAILABLE)(
  "prx-4xb — session-open --create converges onto the workspace actor",
  () => {
    let fixture: ReturnType<typeof makeFixtureRepo>;
    const cleanupPaths: string[] = [];
    beforeEach(() => {
      fixture = makeFixtureRepo();
    });
    afterEach(() => {
      for (const p of cleanupPaths.splice(0)) {
        rmSync(p, { recursive: true, force: true });
      }
      fixture.cleanup();
    });

    test("materializeWorkUnitBranch writes a workspace ledger (one materialization owner)", () => {
      // A bd-style work-unit id with no numeric tail skips the gh/bd issue
      // validation; pre-creating the branch keeps reserve offline (exists-local,
      // no network push). The injected spawn stubs the `git fetch origin` leg
      // (the fixture's origin is a fake github URL) and delegates everything else
      // to real git so the converge path runs end-to-end.
      const workUnitId = `wsconv-${fixture.repoDir.split("/").pop()}`;
      sh(fixture.repoDir, "git", ["branch", workUnitId]);

      const realSpawn = (file: string, args: string[], opts: { cwd: string; encoding: "utf8" }) =>
        spawnSync(file, args, { ...opts, encoding: "utf8" });
      const spawn = (file: string, args: string[], opts: { cwd: string; encoding: "utf8" }) => {
        if (file === "git" && args.join(" ").includes("fetch origin")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        return realSpawn(file, args, opts);
      };

      materializeWorkUnitBranch(workUnitId, fixture.repoDir, spawn);

      // The convergence: a workspace ledger now exists for the materialized unit
      // (the direct addWorktreeForBranch path wrote none). `prx workspace
      // service/teardown` can now see this --create-materialized worktree.
      const commonDir = spawnSync("git", ["-C", fixture.repoDir, "rev-parse", "--git-common-dir"], {
        cwd: fixture.repoDir,
        encoding: "utf8",
      }).stdout.trim();
      const absCommonDir = commonDir.startsWith("/") ? commonDir : join(fixture.repoDir, commonDir);
      const ledgerDir = join(absCommonDir, "info", "workspace");
      cleanupPaths.push(join(fixture.repoDir, "..", workUnitId));
      expect(existsSync(ledgerDir)).toBe(true);
      const ledgers = readdirSync(ledgerDir).filter((f) => f.endsWith(".json"));
      expect(ledgers.length).toBeGreaterThan(0);
    }, 30000);
  },
);

describe.skipIf(!GIT_COMMIT_AVAILABLE)("runWorkspaceCli — argument validation", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("reserve without --branch is a CLI error", () => {
    expect(() =>
      runWorkspaceCli(parseWorkspaceArgs(["reserve"]), {
        cwd: fixture.repoDir,
      }),
    ).toThrow(WorkspaceCliError);
  });

  test("prepare without --lifecycle is a CLI error", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), {
      cwd: fixture.repoDir,
    });
    expect(() =>
      runWorkspaceCli(parseWorkspaceArgs(["prepare"]), {
        cwd: fixture.repoDir,
      }),
    ).toThrow(WorkspaceCliError);
  });

  test("service without --action is a CLI error", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), {
      cwd: fixture.repoDir,
    });
    expect(() =>
      runWorkspaceCli(parseWorkspaceArgs(["service"]), {
        cwd: fixture.repoDir,
      }),
    ).toThrow(WorkspaceCliError);
  });

  test("service --action restart is rejected by parser", () => {
    runWorkspaceCli(parseWorkspaceArgs(["reserve", "--branch", "main"]), {
      cwd: fixture.repoDir,
    });
    expect(() =>
      runWorkspaceCli(parseWorkspaceArgs(["service", "--action", "restart"]), {
        cwd: fixture.repoDir,
      }),
    ).toThrow(WorkspaceCliError);
  });
});
