/**
 * Workspace actor lifecycle + invariants (GH-1978).
 *
 * Exercises the actor against a fixture git repo on a tmp dir:
 *
 *   - I-WS1: reserve is the only entry. prepare/sync/service/teardown
 *     against a workspace with no prior WORKSPACE_RESERVED fail closed.
 *   - I-WS2: tooling-file writes (sync/prepare) are atomic — the
 *     ledger is written via tmp + rename; verify no `.tmp-*` files leak.
 *   - I-WS3: service start --auto with no profile is no-op (no-profile).
 *   - I-WS4: every payload carries workspace_id of the correct shape.
 *
 * Network access is not required: the fixture initializes a bare repo
 * and a worktree without ever talking to GitHub. Beads hydrate is
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
} from "../../src/workspace/actor.ts";
import type { WorktreeSpawn } from "../../src/tools/worktree_layout.ts";

function sh(cwd: string, file: string, args: string[]): void {
  const r = spawnSync(file, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} (cwd=${cwd}) exit=${r.status}\n${r.stderr ?? ""}`,
    );
  }
}

function makeFixtureRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "workspace-actor-"));
  sh(repoDir, "git", ["init", "-b", "main"]);
  sh(repoDir, "git", ["config", "user.email", "test@example.com"]);
  sh(repoDir, "git", ["config", "user.name", "Test"]);
  sh(repoDir, "git", ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]);
  writeFileSync(join(repoDir, "README"), "hello\n");
  sh(repoDir, "git", ["add", "README"]);
  sh(repoDir, "git", ["commit", "-m", "init"]);
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

/**
 * Fixture whose git toplevel basename is literally `mainx` — the read-only
 * replica signal `isMainxPath` keys on. Used to exercise the I-WS5
 * fail-closed guard: reserve writes a ledger with `worktree_path` pointing at
 * this dir, and the gated verbs must refuse against it.
 */
function makeMainxFixtureRepo(): { repoDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "workspace-actor-mainx-"));
  const repoDir = join(parent, "mainx");
  mkdirSync(repoDir);
  sh(repoDir, "git", ["init", "-b", "main"]);
  sh(repoDir, "git", ["config", "user.email", "test@example.com"]);
  sh(repoDir, "git", ["config", "user.name", "Test"]);
  sh(repoDir, "git", ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]);
  writeFileSync(join(repoDir, "README"), "hello\n");
  sh(repoDir, "git", ["add", "README"]);
  sh(repoDir, "git", ["commit", "-m", "init"]);
  return {
    repoDir,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

describe("computeWorkspaceId", () => {
  test("is deterministic", () => {
    const a = computeWorkspaceId("io.github/owner/repo", "GH-1", "/x");
    const b = computeWorkspaceId("io.github/owner/repo", "GH-1", "/x");
    expect(a).toBe(b);
  });

  test("differs per branch (GH-1978 collision contract)", () => {
    const a = computeWorkspaceId("io.github/owner/repo", "GH-1", "/x");
    const b = computeWorkspaceId("io.github/owner/repo", "GH-2", "/x");
    expect(a).not.toBe(b);
  });

  test("is stable across worktree_path (lifecycle stability)", () => {
    // pre-switch cwd vs post-switch cwd must produce the same id —
    // the actor docstring explains why we omit worktree_path from the
    // hash even though the plan initially included it.
    const a = computeWorkspaceId("io.github/owner/repo", "GH-1", "/parent");
    const b = computeWorkspaceId("io.github/owner/repo", "GH-1", "/worktrees/abc");
    expect(a).toBe(b);
  });

  test("matches the 12-hex shape WorkspaceId validates", () => {
    const id = computeWorkspaceId("io.github/owner/repo", "GH-1", "/x");
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe("resolveWorkspaceContext", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("returns null outside a GitHub repo", () => {
    // The bun-test preload remaps TMPDIR into `<repoRoot>/.tmp/bun-tests`
    // so `tmpdir()` here lands inside this worktree — git would walk up
    // to find this very repo. Use `/tmp/` directly so the noRepo dir
    // sits outside any git working tree.
    const noRepo = mkdtempSync("/tmp/workspace-actor-norepo-");
    try {
      const ctx = resolveWorkspaceContext({ cwd: noRepo });
      expect(ctx).toBeNull();
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
    }
  });

  test("yields a workspace_id + ledger path for a real repo", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir });
    expect(ctx).not.toBeNull();
    expect(ctx!.workspaceId).toMatch(/^[a-f0-9]{12}$/);
    expect(ctx!.hostRepoSlug).toBe("io.github/test-owner/test-repo");
    expect(ctx!.branch).toBe("main");
    expect(ctx!.ledgerPath).toContain("/info/workspace/");
    expect(ctx!.ledgerPath.endsWith(`${ctx!.workspaceId}.json`)).toBe(true);
  });
});

describe("resolveCanonicalChainLedger (GH-2338)", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("returns null when there is no prior reserve (AC-5: by-id lookup, no synthesis)", () => {
    // No reserve has written `info/workspace/<id>.json`, so the by-id lookup
    // fails — the canonical ledger only exists for a reserved UoW (I-WS1).
    expect(resolveCanonicalChainLedger(fixture.repoDir)).toBeNull();
  });

  test("resolves <commonDir>/info/provenance/<id>.sqlite for a reserved UoW", () => {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const resolved = resolveCanonicalChainLedger(fixture.repoDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.workspaceId).toBe(reserveOut.workspace_id);
    // Sibling of info/workspace/<id>.json — the per-UoW artifact tree.
    expect(resolved!.ledgerPath).toContain("/info/provenance/");
    expect(resolved!.ledgerPath.endsWith(`${ctx.workspaceId}.sqlite`)).toBe(true);
  });

  test("AC-5: detached HEAD does not synthesize a cwd-HEAD ledger path (returns null)", () => {
    // The reserved-by-id lookup keys on the stable (slug, branch) workspace_id,
    // never the cwd HEAD sha. In detached HEAD the branch is the literal "HEAD",
    // so no reserved ledger matches and the resolver fails closed to null rather
    // than fabricating a path from the commit oid.
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    sh(fixture.repoDir, "git", ["checkout", "--detach"]);
    expect(resolveCanonicalChainLedger(fixture.repoDir)).toBeNull();
  });

  test("I-WS5: refuses (null) on the read-only mainx replica", () => {
    const mainx = makeMainxFixtureRepo();
    try {
      runReserve(
        { branch: "main", base: "origin/main", local_only: false },
        mainx.repoDir,
      );
      // Reserve succeeds (the ledger points at the mainx worktree), but the
      // canonical-ledger resolver must refuse so neither side writes a
      // provenance DB into the replica.
      expect(resolveCanonicalChainLedger(mainx.repoDir)).toBeNull();
    } finally {
      mainx.cleanup();
    }
  });
});

describe("workspace actor lifecycle", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("I-WS1: prepare before reserve fails closed", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runPrepare(
      { workspace_id: ctx.workspaceId, lifecycle: "materialized" },
      fixture.repoDir,
      { hydrateBeads: () => false },
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no prior reserve/);
  });

  test("I-WS1: sync before reserve fails closed", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runSync(
      { workspace_id: ctx.workspaceId },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no prior reserve/);
  });

  test("I-WS1: teardown before reserve fails closed (without --force)", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runTeardown(
      { workspace_id: ctx.workspaceId, force: false },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
  });

  test("I-WS1: service before reserve fails closed", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runService(
      { workspace_id: ctx.workspaceId, action: "start", auto: true },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
  });

  test("teardown with --force on no-ledger is a no-op (skipped)", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runTeardown(
      { workspace_id: ctx.workspaceId, force: true },
      fixture.repoDir,
    );
    expect(out.status).toBe("skipped");
  });

  test("reserve → prepare → sync → teardown happy path", () => {
    // reserve writes the ledger using the existing branch (`main`); the
    // ensureBranch call is a no-op since main already exists locally.
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    expect(["exists-local", "exists-remote", "skipped", "created"]).toContain(
      reserveOut.status,
    );
    expect(reserveOut.workspace_id).toMatch(/^[a-f0-9]{12}$/);

    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    expect(ctx.workspaceId).toBe(reserveOut.workspace_id);

    const prepareOut = runPrepare(
      { workspace_id: ctx.workspaceId, lifecycle: "materialized" },
      fixture.repoDir,
      { hydrateBeads: () => false },
    );
    expect(prepareOut.status).toBe("ok");
    expect(prepareOut.workspace_id).toBe(ctx.workspaceId);

    const syncOut = runSync(
      { workspace_id: ctx.workspaceId },
      fixture.repoDir,
    );
    expect(["ok", "noop"]).toContain(syncOut.status);

    const teardownOut = runTeardown(
      { workspace_id: ctx.workspaceId, force: false },
      fixture.repoDir,
    );
    expect(teardownOut.status).toBe("torn-down");
  });

  test("GH-2258: prepare succeeds when the reserved branch differs from the cwd HEAD (materialized intake/triage in a shared, detached worktree)", () => {
    // The intake/triage `materialized` lifecycle runs session_open inside
    // the shared `mainx` worktree, which sits in detached HEAD and never
    // checks out the ephemeral `intake/<yyyymmdd>-<short>` branch that
    // reserve keys the workspace_id on. Regression: the gated verbs
    // re-derived the branch from the cwd HEAD (`git rev-parse
    // --abbrev-ref HEAD` => "HEAD" when detached), computing a different
    // workspace_id and firing a false `no prior reserve`.
    sh(fixture.repoDir, "git", ["checkout", "--detach"]);

    const branch = "intake/20260526-abc123";
    const reserveOut = runReserve(
      { branch, base: "origin/main", local_only: false },
      fixture.repoDir,
      // The fixture's origin is a fake remote, so a real push of a
      // brand-new branch would fail. The bug is in id/ledger resolution,
      // not branch creation — stub ensureBranch to the `created` path.
      {
        ensureBranchImpl: () => ({
          status: "created",
          branch,
          base: "origin/main",
          remote: "origin",
          created: true,
        }),
      },
    );
    expect(reserveOut.status).toBe("created");

    // prepare receives the authoritative workspace_id and must locate the
    // ledger by it, not by re-deriving the branch from the detached cwd.
    const prepareOut = runPrepare(
      { workspace_id: reserveOut.workspace_id, lifecycle: "materialized" },
      fixture.repoDir,
      { hydrateBeads: () => false },
    );
    expect(prepareOut.status).toBe("ok");
    expect(prepareOut.workspace_id).toBe(reserveOut.workspace_id);
  });

  test("prx-jkb: materialized (triage/intake) prepare writes a beads redirect and never hydrates", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;

    // A launchCwd DISTINCT from cwd — openSession chdir's into the worktree
    // before prepare, so the redirect source must be launchCwd, NOT cwd
    // (regression guard for the v0.1.6 src===dest no-op).
    const launchDir = "/tmp/prx-jkb-launcher";
    let redirectArgs: { src: string; dest: string } | null = null;
    let hydrateCalled = false;
    const prepareOut = runPrepare(
      { workspace_id: ctx.workspaceId, lifecycle: "materialized", launchCwd: launchDir },
      fixture.repoDir,
      {
        // hydrate must NOT run for the materialized lifecycle…
        hydrateBeads: () => {
          hydrateCalled = true;
          return true;
        },
        // …instead, a .beads/redirect points the new worktree at the launching
        // workspace so bd uses its server rather than spawning a stray (prx-jkb).
        writeRedirect: (src, dest) => {
          redirectArgs = { src, dest };
          return [join(dest, ".beads", "redirect")];
        },
      },
    );

    expect(prepareOut.status).toBe("ok");
    expect(hydrateCalled).toBe(false);
    expect(redirectArgs).not.toBeNull();
    // source is the launching workspace (launchCwd), NOT cwd (the worktree).
    expect(redirectArgs!.src).toBe(launchDir);
    expect(redirectArgs!.src).not.toBe(fixture.repoDir);
    expect(prepareOut.files_written).toContain(
      join(redirectArgs!.dest, ".beads", "redirect"),
    );
  });

  test("prx-jkb: attached lifecycle hydrates and does NOT write a redirect", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;

    let redirectCalled = false;
    let hydrateCalled = false;
    const prepareOut = runPrepare(
      { workspace_id: ctx.workspaceId, lifecycle: "attached" },
      fixture.repoDir,
      {
        hydrateBeads: () => {
          hydrateCalled = true;
          return true;
        },
        writeRedirect: () => {
          redirectCalled = true;
          return [];
        },
      },
    );

    expect(prepareOut.status).toBe("ok");
    expect(hydrateCalled).toBe(true);
    expect(redirectCalled).toBe(false);
  });

  test("I-WS3: service start --auto with no compose profile is no-op", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runService(
      { workspace_id: ctx.workspaceId, action: "start", auto: true },
      fixture.repoDir,
    );
    expect(out.status).toBe("no-profile");
    expect(out.compose_files).toEqual([]);
  });

  test("I-WS3: service start without --auto and no profile is `skipped`", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runService(
      { workspace_id: ctx.workspaceId, action: "start", auto: false },
      fixture.repoDir,
    );
    expect(out.status).toBe("skipped");
  });

  test("I-WS2: ledger writes are atomic (no .tmp-* file remains)", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const ledgerDir = ctx.ledgerPath.replace(/\/[^/]+$/, "");
    const entries = readdirSync(ledgerDir);
    expect(entries.every((f) => !f.startsWith(`${ctx.workspaceId}.json.tmp-`))).toBe(true);
  });

  test("I-WS4: every payload carries the right workspace_id", () => {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const wid = reserveOut.workspace_id;
    expect(wid).toMatch(/^[a-f0-9]{12}$/);

    const prepareOut = runPrepare(
      { workspace_id: wid, lifecycle: "materialized" },
      fixture.repoDir,
      { hydrateBeads: () => false },
    );
    expect(prepareOut.workspace_id).toBe(wid);

    const syncOut = runSync({ workspace_id: wid }, fixture.repoDir);
    expect(syncOut.workspace_id).toBe(wid);

    const serviceOut = runService(
      { workspace_id: wid, action: "start", auto: true },
      fixture.repoDir,
    );
    expect(serviceOut.workspace_id).toBe(wid);

    const teardownOut = runTeardown(
      { workspace_id: wid, force: false },
      fixture.repoDir,
    );
    expect(teardownOut.workspace_id).toBe(wid);
  });
});

describe("workspace.materialize (GH-2271 / ai-home-rkg1w.1)", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  // A WorktreeSpawn fake so the git `worktree add` core is exercised
  // without touching disk — the real-git on-disk shape is asserted by the
  // session-open integration test (test/session/open.integration.test.ts).
  function fakeSpawn(opts: {
    registered?: boolean;
    branchExists?: boolean;
    addExit?: number;
  }): { spawn: WorktreeSpawn; calls: string[][] } {
    const calls: string[][] = [];
    const spawn: WorktreeSpawn = (file, args) => {
      calls.push([file, ...args]);
      const joined = args.join(" ");
      if (joined.includes("worktree list")) {
        return {
          status: 0,
          stdout: opts.registered ? "worktree /repo-parent/main\n" : "",
        };
      }
      if (joined.includes("show-ref")) {
        return { status: opts.branchExists === false ? 1 : 0 };
      }
      if (joined.includes("worktree add")) {
        return {
          status: opts.addExit ?? 0,
          stderr: opts.addExit ? "fatal: worktree add failed" : "",
        };
      }
      return { status: 0 };
    };
    return { spawn, calls };
  }

  test("I-WS1: materialize before reserve fails closed", () => {
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const out = runMaterialize(
      { workspace_id: ctx.workspaceId },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no prior reserve/);
  });

  test("materialize adds the worktree and records ledger state=materialized + real path", () => {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const { spawn, calls } = fakeSpawn({ branchExists: true });
    const out = runMaterialize(
      { workspace_id: reserveOut.workspace_id },
      fixture.repoDir,
      { spawn, repoToplevel: () => "/repo-parent/repo" },
    );
    expect(out.status).toBe("created");
    expect(out.worktree_path).toBe("/repo-parent/main");
    expect(out.branch).toBe("main");
    // It ran `git worktree add` against the resolved repo toplevel.
    expect(calls.some((c) => c.join(" ").includes("worktree add"))).toBe(true);

    // Ledger advanced to materialized with the authoritative path.
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const ledger = JSON.parse(readFileSync(ctx.ledgerPath, "utf8")) as {
      state: string;
      worktree_path: string;
    };
    expect(ledger.state).toBe("materialized");
    expect(ledger.worktree_path).toBe("/repo-parent/main");
  });

  test("materialize is idempotent — an already-registered worktree returns exists", () => {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const { spawn, calls } = fakeSpawn({ registered: true });
    const out = runMaterialize(
      { workspace_id: reserveOut.workspace_id },
      fixture.repoDir,
      { spawn, repoToplevel: () => "/repo-parent/repo" },
    );
    expect(out.status).toBe("exists");
    // No `git worktree add` on the idempotent path.
    expect(calls.some((c) => c.join(" ").includes("worktree add"))).toBe(false);
  });

  test("materialize surfaces a worktree-add failure as status=error", () => {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const { spawn } = fakeSpawn({ branchExists: true, addExit: 1 });
    const out = runMaterialize(
      { workspace_id: reserveOut.workspace_id },
      fixture.repoDir,
      { spawn, repoToplevel: () => "/repo-parent/repo" },
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/workspace\.materialize/);
  });
});

describe("workspace.service compose dispatch", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("starts compose when both yml files exist (injected runner)", () => {
    writeFileSync(join(fixture.repoDir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(fixture.repoDir, "compose.worktree.yml"), "services: {}\n");
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const calls: Array<{ files: string[]; action: string }> = [];
    const out = runService(
      { workspace_id: ctx.workspaceId, action: "start", auto: true },
      fixture.repoDir,
      {
        runCompose: ({ files, action }) => {
          calls.push({ files, action });
          return { exitCode: 0 };
        },
      },
    );
    expect(out.status).toBe("started");
    expect(out.compose_files).toEqual(["docker-compose.yml", "compose.worktree.yml"]);
    expect(calls).toEqual([
      { files: ["docker-compose.yml", "compose.worktree.yml"], action: "up" },
    ]);
  });

  test("stops compose with action=stop", () => {
    writeFileSync(join(fixture.repoDir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(fixture.repoDir, "compose.worktree.yml"), "services: {}\n");
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    const calls: Array<{ files: string[]; action: string }> = [];
    const out = runService(
      { workspace_id: ctx.workspaceId, action: "stop", auto: false },
      fixture.repoDir,
      {
        runCompose: ({ files, action }) => {
          calls.push({ files, action });
          return { exitCode: 0 };
        },
      },
    );
    expect(out.status).toBe("stopped");
    expect(calls[0]?.action).toBe("down");
  });
});

describe("I-WS5: fail-closed mainx guard", () => {
  let fixture: ReturnType<typeof makeMainxFixtureRepo>;
  beforeEach(() => {
    fixture = makeMainxFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  /** Reserve a workspace whose ledger worktree_path basename is `mainx`. */
  function reserveOnMainx(): { workspaceId: string; ledgerPath: string } {
    const reserveOut = runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    expect(["exists-local", "exists-remote", "skipped", "created"]).toContain(
      reserveOut.status,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    // confirm the ledger really points at a mainx-named worktree
    const ledger = JSON.parse(readFileSync(ctx.ledgerPath, "utf8")) as {
      worktree_path: string;
      state: string;
    };
    expect(ledger.worktree_path.endsWith("/mainx")).toBe(true);
    expect(ledger.state).toBe("reserved");
    return { workspaceId: ctx.workspaceId, ledgerPath: ctx.ledgerPath };
  }

  function ledgerState(ledgerPath: string): string {
    return (JSON.parse(readFileSync(ledgerPath, "utf8")) as { state: string }).state;
  }

  test("prepare against a mainx-resolved ledger fails closed (no state advance)", () => {
    const { workspaceId, ledgerPath } = reserveOnMainx();
    const out = runPrepare(
      { workspace_id: workspaceId, lifecycle: "materialized" },
      fixture.repoDir,
      { hydrateBeads: () => false },
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/read-only mainx replica/);
    // ledger never advanced past `reserved`
    expect(ledgerState(ledgerPath)).toBe("reserved");
  });

  test("sync against a mainx-resolved ledger fails closed", () => {
    const { workspaceId, ledgerPath } = reserveOnMainx();
    const out = runSync({ workspace_id: workspaceId }, fixture.repoDir);
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/read-only mainx replica/);
    expect(ledgerState(ledgerPath)).toBe("reserved");
  });

  test("service against a mainx-resolved ledger fails closed", () => {
    const { workspaceId, ledgerPath } = reserveOnMainx();
    const out = runService(
      { workspace_id: workspaceId, action: "start", auto: true },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/read-only mainx replica/);
    expect(ledgerState(ledgerPath)).toBe("reserved");
  });

  test("teardown against a mainx-resolved ledger fails closed", () => {
    const { workspaceId, ledgerPath } = reserveOnMainx();
    const out = runTeardown(
      { workspace_id: workspaceId, force: false },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/read-only mainx replica/);
    expect(ledgerState(ledgerPath)).toBe("reserved");
  });

  test("teardown --force on a mainx-resolved ledger: the guard wins over --force (error, not skipped)", () => {
    const { workspaceId, ledgerPath } = reserveOnMainx();
    const out = runTeardown(
      { workspace_id: workspaceId, force: true },
      fixture.repoDir,
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/read-only mainx replica/);
    expect(ledgerState(ledgerPath)).toBe("reserved");
  });
});

describe("workspace lifecycle ledger", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => fixture.cleanup());

  test("reserve creates the ledger file at git common-dir", () => {
    runReserve(
      { branch: "main", base: "origin/main", local_only: false },
      fixture.repoDir,
    );
    const ctx = resolveWorkspaceContext({ cwd: fixture.repoDir })!;
    expect(existsSync(ctx.ledgerPath)).toBe(true);
  });
});
