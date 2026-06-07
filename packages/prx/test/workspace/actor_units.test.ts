/**
 * workspace actor (GH-1978) — signing-independent unit coverage.
 *
 * The fixture suite in actor.test.ts drives the real ensureBranch git path,
 * which needs `git commit` (and thus a signing agent that isn't reachable
 * locally / in the CI signing proxy). This suite stays hermetic: a bare
 * `git init` tmpdir (no commits — only `rev-parse` is consulted) plus the
 * actor's DI seams (ensureBranchImpl, keeper git/exists/remove, hydrateBeads,
 * writeRedirect, runCompose) cover every run* verb, the I-WS1 gate, the I-WS5
 * mainx guard, and the error arms without a single commit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  computeWorkspaceId,
  resolveCanonicalChainLedger,
  resolveWorkspaceContext,
  runMaterialize,
  runPrepare,
  runReserve,
  runService,
  runSync,
  runTeardown,
  type WorkspaceLedger,
} from "../../src/workspace/actor.ts";
import type { WorkspaceId } from "../../src/workspace/schema.ts";
import type { EnsureBranchResult, EnsureBranchStatus } from "../../src/tools/ensure_branch.ts";

/** Build a full EnsureBranchResult for the injected ensureBranch seam. */
const ensureImpl = (status: EnsureBranchStatus, message?: string) => () =>
  ({
    status,
    branch: "feat",
    base: "origin/main",
    remote: null,
    created: status === "created",
    ...(message ? { message } : {}),
  }) satisfies EnsureBranchResult;

function sh(cwd: string, file: string, args: string[]): void {
  const r = spawnSync(file, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) throw new Error(`${file} ${args.join(" ")}: ${r.stderr}`);
}

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A git repo with a GitHub origin and one signing-disabled commit, so
 *  `git rev-parse --abbrev-ref HEAD` resolves `main` without a signing agent. */
function gitRepo(originUrl = "git@github.com:o/r.git"): string {
  const dir = realpathSync(mkdtempSync("/tmp/ws-actor-"));
  cleanups.push(dir);
  sh(dir, "git", ["init", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@e.com"]);
  sh(dir, "git", ["config", "user.name", "T"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  sh(dir, "git", ["remote", "add", "origin", originUrl]);
  sh(dir, "git", ["commit", "--allow-empty", "-m", "init"]);
  return dir;
}

/** Directly write a workspace ledger for a given id under the repo's common dir. */
function writeLedgerFor(repo: string, id: WorkspaceId, ledger: Partial<WorkspaceLedger>): void {
  const commonDir = join(repo, ".git", "info", "workspace");
  mkdirSync(commonDir, { recursive: true });
  const full: WorkspaceLedger = {
    workspace_id: id,
    branch: "feat",
    worktree_path: repo,
    host_repo_slug: "github.com/o/r",
    state: "reserved",
    reserved_at: "2026-01-01T00:00:00.000Z",
    ...ledger,
  };
  writeFileSync(join(commonDir, `${id}.json`), `${JSON.stringify(full, null, 2)}\n`);
}

// ── computeWorkspaceId / resolveWorkspaceContext ────────────────────────────

describe("computeWorkspaceId + resolveWorkspaceContext", () => {
  test("the id is a stable 12-hex of (slug, branch), path-independent", () => {
    const a = computeWorkspaceId("github.com/o/r", "feat", "/p1");
    const b = computeWorkspaceId("github.com/o/r", "feat", "/p2");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{12}$/);
  });

  test("resolves a full context from a recognized repo cwd", () => {
    const repo = gitRepo();
    const ctx = resolveWorkspaceContext({ cwd: repo, branch: "feat" });
    expect(ctx).not.toBeNull();
    expect(ctx!.hostRepoSlug).toBe("io.github/o/r");
    expect(ctx!.branch).toBe("feat");
  });

  test("returns null for a non-GitHub origin", () => {
    const repo = gitRepo();
    expect(resolveWorkspaceContext({ cwd: repo, branch: "feat", originUrl: "https://example.com/x.git" })).toBeNull();
  });

  test("returns null when worktree path is unresolvable (not a repo)", () => {
    const dir = realpathSync(mkdtempSync("/tmp/ws-actor-norepo-"));
    cleanups.push(dir);
    expect(resolveWorkspaceContext({ cwd: dir, branch: "feat" })).toBeNull();
  });
});

// ── reserve ─────────────────────────────────────────────────────────────────

describe("runReserve", () => {
  test("writes a ledger and maps ensureBranch status on success", () => {
    const repo = gitRepo();
    const out = runReserve({ branch: "feat", base: "origin/main", local_only: false }, repo, {
      ensureBranchImpl: ensureImpl("exists-local"),
    });
    expect(out.status).toBe("exists-local");
    expect(out.workspace_id).toMatch(/^[a-f0-9]{12}$/);
  });

  test("does NOT write a ledger on a base-unresolved result (no gate poisoning)", () => {
    const repo = gitRepo();
    const out = runReserve({ branch: "feat", base: "origin/missing", local_only: false }, repo, {
      ensureBranchImpl: ensureImpl("base-unresolved", "no such base"),
    });
    expect(out.status).toBe("base-unresolved");
    expect(out.error).toBe("no such base");
    // The gate must still report "no prior reserve" because no ledger was written.
    const gate = runSync({ workspace_id: out.workspace_id }, repo);
    expect(gate.status).toBe("error");
    expect(gate.error).toContain("no prior reserve");
  });

  test("error when cwd is not a recognized GitHub repo", () => {
    const repo = gitRepo();
    const out = runReserve({ branch: "feat", base: "origin/main", local_only: false }, repo, {
      originUrl: "https://example.com/x.git",
      ensureBranchImpl: ensureImpl("created"),
    });
    expect(out.status).toBe("error");
    expect(out.workspace_id).toBe("000000000000");
  });
});

// ── a reserve→sync→service→teardown lifecycle on one fixture ────────────────

describe("gated verbs after a real reserve", () => {
  function reserved(): { repo: string; id: WorkspaceId } {
    const repo = gitRepo();
    const out = runReserve({ branch: "feat", base: "origin/main", local_only: false }, repo, {
      ensureBranchImpl: ensureImpl("created"),
    });
    return { repo, id: out.workspace_id };
  }

  test("sync reports noop when there is no tooling drift", () => {
    const { repo, id } = reserved();
    const out = runSync({ workspace_id: id }, repo);
    expect(["noop", "ok"]).toContain(out.status);
    expect(out.workspace_id).toBe(id);
  });

  test("prepare (non-materialized) hydrates beads via the injected seam", () => {
    const { repo, id } = reserved();
    let hydrateCwd = "";
    const out = runPrepare({ workspace_id: id, lifecycle: "attached" }, repo, {
      hydrateBeads: (cwd) => {
        hydrateCwd = cwd;
        return true;
      },
    });
    expect(out.status).toBe("ok");
    expect(out.beads_hydrated).toBe(true);
    expect(hydrateCwd).toBe(repo);
  });

  test("prepare (materialized) writes a beads redirect instead of hydrating", () => {
    const { repo, id } = reserved();
    const out = runPrepare({ workspace_id: id, lifecycle: "materialized", launchCwd: "/launch" }, repo, {
      writeRedirect: (src, dest) => [`${src}->${dest}/.beads/redirect`],
    });
    expect(out.status).toBe("ok");
    expect(out.files_written.some((f) => f.includes("/launch->"))).toBe(true);
  });

  test("service start with no compose profile + --auto is a no-op", () => {
    const { repo, id } = reserved();
    const out = runService({ workspace_id: id, action: "start", auto: true }, repo);
    expect(out.status).toBe("no-profile");
  });

  test("service start with no compose profile, non-auto, is skipped with a hint", () => {
    const { repo, id } = reserved();
    const out = runService({ workspace_id: id, action: "start", auto: false }, repo);
    expect(out.status).toBe("skipped");
    expect(out.error).toContain("no compose profile");
  });

  test("service start with a compose profile runs the injected runner → started", () => {
    const { repo, id } = reserved();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(repo, "compose.worktree.yml"), "services: {}\n");
    let action = "";
    const out = runService({ workspace_id: id, action: "start", auto: false }, repo, {
      runCompose: (args) => {
        action = args.action;
        return { exitCode: 0 };
      },
    });
    expect(out.status).toBe("started");
    expect(action).toBe("up");
    expect(out.compose_files).toHaveLength(2);
  });

  test("service stop with a compose profile → stopped (down)", () => {
    const { repo, id } = reserved();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(repo, "compose.worktree.yml"), "services: {}\n");
    const out = runService({ workspace_id: id, action: "stop", auto: false }, repo, {
      runCompose: () => ({ exitCode: 0 }),
    });
    expect(out.status).toBe("stopped");
  });

  test("service surfaces a non-zero compose exit as an error", () => {
    const { repo, id } = reserved();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(repo, "compose.worktree.yml"), "services: {}\n");
    const out = runService({ workspace_id: id, action: "start", auto: false }, repo, {
      runCompose: () => ({ exitCode: 2, stderr: "boom" }),
    });
    expect(out.status).toBe("error");
    expect(out.error).toBe("boom");
  });

  test("teardown moves the ledger to torn_down and reports it cleaned", () => {
    const { repo, id } = reserved();
    const out = runTeardown({ workspace_id: id, force: false }, repo);
    expect(out.status).toBe("torn-down");
    expect(out.cleaned).toHaveLength(1);
  });
});

// ── I-WS1 gate failures (no prior reserve) ──────────────────────────────────

describe("I-WS1 gate — no prior reserve", () => {
  const id = "bbbbbbbbbbbb" as WorkspaceId;
  test("prepare fails closed", () => {
    const repo = gitRepo();
    expect(runPrepare({ workspace_id: id, lifecycle: "attached" }, repo).status).toBe("error");
  });
  test("service fails closed", () => {
    const repo = gitRepo();
    expect(runService({ workspace_id: id, action: "start", auto: false }, repo).status).toBe("error");
  });
  test("materialize fails closed", () => {
    const repo = gitRepo();
    expect(runMaterialize({ workspace_id: id }, repo).status).toBe("error");
  });
  test("teardown --force on a never-reserved workspace skips", () => {
    const repo = gitRepo();
    const out = runTeardown({ workspace_id: id, force: true }, repo);
    expect(out.status).toBe("skipped");
  });
  test("teardown without --force fails closed", () => {
    const repo = gitRepo();
    expect(runTeardown({ workspace_id: id, force: false }, repo).status).toBe("error");
  });
});

// ── I-WS5 mainx guard (ledger worktree_path resolves to a mainx replica) ────

describe("I-WS5 mainx guard", () => {
  const id = "cccccccccccc" as WorkspaceId;
  function repoWithMainxLedger(): string {
    const repo = gitRepo();
    writeLedgerFor(repo, id, { worktree_path: join(repo, "mainx") });
    return repo;
  }
  test("prepare refuses the read-only mainx replica", () => {
    const out = runPrepare({ workspace_id: id, lifecycle: "attached" }, repoWithMainxLedger());
    expect(out.status).toBe("error");
    expect(out.error).toContain("read-only mainx replica");
  });
  test("sync refuses the mainx replica", () => {
    expect(runSync({ workspace_id: id }, repoWithMainxLedger()).status).toBe("error");
  });
  test("service refuses the mainx replica", () => {
    expect(runService({ workspace_id: id, action: "start", auto: false }, repoWithMainxLedger()).status).toBe("error");
  });
  test("teardown --force still refuses the mainx replica (guard wins over force)", () => {
    const out = runTeardown({ workspace_id: id, force: true }, repoWithMainxLedger());
    expect(out.status).toBe("error");
    expect(out.error).toContain("mainx");
  });
});

// ── error arms: corrupt ledger + un-writable worktree ──────────────────────

describe("error arms", () => {
  test("a corrupt ledger JSON reads as no-ledger → gate failure", () => {
    const repo = gitRepo();
    const id = "eeeeeeeeeeee" as WorkspaceId;
    const commonDir = join(repo, ".git", "info", "workspace");
    mkdirSync(commonDir, { recursive: true });
    writeFileSync(join(commonDir, `${id}.json`), "{ not valid json");
    const out = runSync({ workspace_id: id }, repo);
    expect(out.status).toBe("error");
    expect(out.error).toContain("no prior reserve");
  });

  // The prepare/sync tooling-write try/catch arms (actor.ts 579-585 / 628-634)
  // and defaultRunCompose (real `docker compose`) are defensive IO / integration
  // boundaries: ensurePrxExcludes no-ops rather than throwing on a bad repo root
  // (early-return guard), so the catch can't be reached hermetically.
});

// ── materialize via the keeper seam ─────────────────────────────────────────

describe("runMaterialize — keeper seam", () => {
  const id = "dddddddddddd" as WorkspaceId;
  // A git stub satisfying runKeeperEnsureWorktree: registered iff `list` reports
  // the target; everything else exits 0.
  const gitStub = (registeredTarget?: string) => (call: { subcommand: string; args: string[] }) => {
    if (call.subcommand === "worktree" && call.args[0] === "list") {
      return { exitCode: 0, stdout: registeredTarget ? `worktree ${registeredTarget}\n` : "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  test("creates a fresh worktree (status created)", () => {
    const repo = gitRepo();
    writeLedgerFor(repo, id, { branch: "feat", worktree_path: repo });
    const out = runMaterialize({ workspace_id: id }, repo, {
      repoToplevel: () => repo,
      git: gitStub() as never,
      exists: () => false,
      remove: () => {},
    });
    expect(out.status).toBe("created");
    expect(out.branch).toBe("feat");
  });

  test("reports exists for an already-registered healthy worktree", () => {
    const repo = gitRepo();
    writeLedgerFor(repo, id, { branch: "feat", worktree_path: repo });
    const target = join(repo.replace(/\/[^/]+$/, ""), "feat"); // dirname(repo)/feat
    const out = runMaterialize({ workspace_id: id }, repo, {
      repoToplevel: () => repo,
      git: gitStub(target) as never,
      exists: () => true,
      remove: () => {},
    });
    expect(out.status).toBe("exists");
  });

  test("error when repo toplevel is unresolvable", () => {
    const repo = gitRepo();
    writeLedgerFor(repo, id, { branch: "feat", worktree_path: repo });
    const out = runMaterialize({ workspace_id: id }, repo, { repoToplevel: () => null });
    expect(out.status).toBe("error");
    expect(out.error).toContain("cannot resolve repo toplevel");
  });

  test("error when the keeper git add fails", () => {
    const repo = gitRepo();
    writeLedgerFor(repo, id, { branch: "feat", worktree_path: repo });
    const out = runMaterialize({ workspace_id: id }, repo, {
      repoToplevel: () => repo,
      git: ((call: { subcommand: string; args: string[] }) =>
        call.subcommand === "worktree" && call.args[0] === "add"
          ? { exitCode: 1, stdout: "", stderr: "add failed" }
          : { exitCode: 0, stdout: "", stderr: "" }) as never,
      exists: () => false,
      remove: () => {},
    });
    expect(out.status).toBe("error");
    expect(out.error).toContain("workspace.materialize:");
  });
});

// ── resolveCanonicalChainLedger (GH-2338 / I-PROV1) ─────────────────────────

describe("resolveCanonicalChainLedger", () => {
  test("null when there is no prior reserve", () => {
    const repo = gitRepo();
    expect(resolveCanonicalChainLedger(repo)).toBeNull();
  });

  test("resolves the per-UoW provenance ledger path after a reserve", () => {
    const repo = gitRepo();
    runReserve({ branch: "main", base: "origin/main", local_only: false }, repo, {
      ensureBranchImpl: ensureImpl("created"),
    });
    // reserve hashes (slug, branch); resolveCanonicalChainLedger recomputes the
    // same id from the cwd context (branch resolves to the fixture's `main`).
    const resolved = resolveCanonicalChainLedger(repo);
    expect(resolved).not.toBeNull();
    expect(resolved!.ledgerPath).toContain(join("info", "provenance"));
    expect(resolved!.ledgerPath).toContain(".sqlite");
  });

  test("null when the reserved worktree resolves to the mainx replica (I-WS5)", () => {
    const repo = gitRepo();
    // Compute the id reserve WOULD mint for branch `main`, then plant a mainx ledger.
    const ctx = resolveWorkspaceContext({ cwd: repo, branch: "main" });
    writeLedgerFor(repo, ctx!.workspaceId, { branch: "main", worktree_path: join(repo, "mainx") });
    expect(resolveCanonicalChainLedger(repo)).toBeNull();
  });
});
