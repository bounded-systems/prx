// GH-1702 — `prx beads sync-all` cross-repo `prx dolt reconcile` fan-out.
//
// Coverage spans both the orchestrator (`runDoltReconcileAcrossRepos`, with
// every external dep injected — inventory loader, classifier, the per-repo
// `runDoltReconcileWithResult`, audit sink, clock) and the CLI dispatch
// layer (the GH-1697 regression guard: `--repo <slug>` must resolve via
// `findRepoBySlug`, not echo the flag value as a label).

import { describe, expect, test } from "bun:test";

import {
  runDoltReconcileAcrossRepos,
  type RunDoltReconcileAcrossReposDeps,
  type RunDoltReconcileAcrossReposOptions,
} from "../../src/sync/run-dolt-reconcile-cross-repo.ts";
import type {
  BeadsStateForReconcile,
  DoltReconcileCandidate,
  IndexedRepoForDoltReconcile,
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";
import type {
  DoltReconcileOptions,
  DoltReconcileResult,
  DoltReconcileStep,
} from "../../src/pr-state/dolt-reconcile.ts";
import { runCli } from "../../src/pr-state/cli.ts";

const FIXED_NOW = new Date("2026-05-18T09:00:00.000Z");

// ── fixtures ───────────────────────────────────────────────────────────────

function eligibleRepo(
  slug: string,
  over: Partial<IndexedRepoForDoltReconcile> = {},
): DoltReconcileCandidate {
  return {
    kind: "eligible",
    repo: {
      slug,
      nameWithOwner: `bdelanghe/${slug}`,
      barePath: `/bare/${slug}`,
      doltRemote: `https://doltremoteapi.dolthub.com/bdelanghe/${slug}`,
      ...over,
    },
  };
}

function skippedRepo(
  slug: string,
  reason: "no-remote" | "legacy-embedded",
  nameWithOwner: string | null = `bdelanghe/${slug}`,
): DoltReconcileCandidate {
  return { kind: "skipped", slug, nameWithOwner, reason };
}

function okStep(name: DoltReconcileStep["step"]): DoltReconcileStep {
  return {
    step: name,
    status: "ok",
    exitCode: 0,
    command: `bd dolt ${name}`,
  };
}

function previewStep(name: DoltReconcileStep["step"]): DoltReconcileStep {
  return {
    step: name,
    status: "preview",
    exitCode: 0,
    command: `bd dolt ${name}`,
  };
}

function skippedStep(name: DoltReconcileStep["step"]): DoltReconcileStep {
  return {
    step: name,
    status: "skipped",
    exitCode: 1,
    command: `bd dolt ${name}`,
    stderrTail: "nothing to commit",
  };
}

function failedStep(name: DoltReconcileStep["step"], stderr: string): DoltReconcileStep {
  return {
    step: name,
    status: "failed",
    exitCode: 1,
    command: `bd dolt ${name}`,
    stderrTail: stderr,
  };
}

function reconciled(steps: DoltReconcileStep[], mode: DoltReconcileResult["mode"] = "full"): DoltReconcileResult {
  return { state: "reconciled", steps, mode };
}

function stuck(steps: DoltReconcileStep[], hint: string, mode: DoltReconcileResult["mode"] = "full"): DoltReconcileResult {
  return { state: "stuck", steps, hint, mode };
}

function conflict(steps: DoltReconcileStep[], mode: DoltReconcileResult["mode"] = "full"): DoltReconcileResult {
  return {
    state: "schemaConflictPending",
    steps,
    hint: "dolt schema-level merge conflict on `wisps`.\nResolution sketch: ...",
    conflict: { kind: "schema", table: "wisps" },
    mode,
  };
}

type FakeCall = { repoPath: string; mode: DoltReconcileOptions["mode"]; dryRun: boolean };

function makeDeps(
  over: Partial<RunDoltReconcileAcrossReposDeps> & {
    candidates?: DoltReconcileCandidate[];
    perRepoResults?: Record<string, { exitCode: number; result: DoltReconcileResult } | Error>;
  } = {},
): {
  deps: RunDoltReconcileAcrossReposDeps;
  rows: { event: string; details?: Record<string, unknown>; repo?: string }[];
  logs: string[];
  errs: string[];
  calls: FakeCall[];
  output: { log: (l: string) => void; error: (l: string) => void };
} {
  const rows: { event: string; details?: Record<string, unknown>; repo?: string }[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  const calls: FakeCall[] = [];
  const perRepoResults = over.perRepoResults ?? {};
  const deps: RunDoltReconcileAcrossReposDeps = {
    cwd: () => "/repo",
    runDoltReconcile: (opts, _out) => {
      calls.push({
        repoPath: opts.repoPath,
        mode: opts.mode,
        dryRun: opts.dryRun,
      });
      const fixture = perRepoResults[opts.repoPath];
      if (fixture instanceof Error) {
        throw fixture;
      }
      if (fixture) {
        return fixture;
      }
      // Default: success with the requested mode.
      const mode = opts.mode ?? "full";
      const steps =
        opts.dryRun
          ? (mode === "pull-only"
              ? [previewStep("pull")]
              : mode === "push-only"
                ? [previewStep("commit"), previewStep("push")]
                : [previewStep("commit"), previewStep("pull"), previewStep("push")])
          : (mode === "pull-only"
              ? [okStep("pull")]
              : mode === "push-only"
                ? [okStep("commit"), okStep("push")]
                : [okStep("commit"), okStep("pull"), okStep("push")]);
      const state: DoltReconcileResult["state"] = opts.dryRun ? "preview" : "reconciled";
      return { exitCode: 0, result: { state, steps, mode } };
    },
    appendAuditRow: (row) => {
      const r = row as { event?: string; details?: Record<string, unknown>; repo?: string };
      if (typeof r.event === "string") {
        rows.push({ event: r.event, ...(r.details ? { details: r.details } : {}), ...(r.repo ? { repo: r.repo } : {}) });
      }
    },
    getAuditRuntimeContext: () => ({ verb: "beads.sync-all", actor: "test-actor", ghTruthReason: null, source: null }),
    now: () => FIXED_NOW,
    ...over,
  };
  return {
    deps,
    rows,
    logs,
    errs,
    calls,
    output: { log: (l) => logs.push(l), error: (l) => errs.push(l) },
  };
}

function opts(over: Partial<RunDoltReconcileAcrossReposOptions> = {}): RunDoltReconcileAcrossReposOptions {
  return { mode: "full", dryRun: false, format: "plain", ...over };
}

// ── orchestrator tests ─────────────────────────────────────────────────────

describe("runDoltReconcileAcrossRepos — happy path", () => {
  test("three eligible repos all reconcile clean; exit 0 and three success rows", async () => {
    const candidates = [eligibleRepo("ai-home"), eligibleRepo("demo-repo"), eligibleRepo("chronologic")];
    const { deps, output, calls, rows } = makeDeps();
    const { exitCode, result } = await runDoltReconcileAcrossRepos(opts({ candidates }), output, deps);
    expect(exitCode).toBe(0);
    expect(result.perRepo).toHaveLength(3);
    expect(result.perRepo.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(calls.map((c) => c.repoPath)).toEqual([
      "/bare/ai-home",
      "/bare/demo-repo",
      "/bare/chronologic",
    ]);
    expect(calls.every((c) => c.mode === "full")).toBe(true);
    // Audit: ALL_STARTED → 3 × (REPO_STARTED, REPO_RECONCILED) → ALL_COMPLETED
    expect(rows[0]?.event).toBe("DOLT_SYNC_ALL_STARTED");
    expect(rows[rows.length - 1]?.event).toBe("DOLT_SYNC_ALL_COMPLETED");
    expect(rows.filter((r) => r.event === "DOLT_SYNC_REPO_STARTED")).toHaveLength(3);
    expect(rows.filter((r) => r.event === "DOLT_SYNC_REPO_RECONCILED")).toHaveLength(3);
  });
});

describe("runDoltReconcileAcrossRepos — mixed states (per-repo isolation)", () => {
  test("success + conflict + failed + no-remote + legacy-embedded; exit 1; walk does not abort on first failure", async () => {
    const candidates = [
      eligibleRepo("ok-repo"),
      eligibleRepo("conflict-repo"),
      eligibleRepo("failed-repo"),
      skippedRepo("no-remote-repo", "no-remote", null),
      skippedRepo("embedded-repo", "legacy-embedded"),
    ];
    const { deps, output, calls } = makeDeps({
      candidates,
      perRepoResults: {
        "/bare/conflict-repo": {
          exitCode: 1,
          result: conflict([failedStep("commit", "schema conflict")]),
        },
        "/bare/failed-repo": {
          exitCode: 1,
          result: stuck([failedStep("push", "remote rejected")], "dolt push rejected; ..."),
        },
      },
    });
    const { exitCode, result } = await runDoltReconcileAcrossRepos(opts({ candidates }), output, deps);
    expect(exitCode).toBe(1);
    expect(result.perRepo.map((r) => `${r.slug}:${r.status}`)).toEqual([
      "ok-repo:success",
      "conflict-repo:conflict",
      "failed-repo:failed",
      "no-remote-repo:skipped",
      "embedded-repo:skipped",
    ]);
    // Skipped repos must include the reason, eligible repos must not.
    expect(result.perRepo.find((r) => r.slug === "no-remote-repo")?.skipReason).toBe("no-remote");
    expect(result.perRepo.find((r) => r.slug === "embedded-repo")?.skipReason).toBe("legacy-embedded");
    expect(result.perRepo.find((r) => r.slug === "ok-repo")?.skipReason).toBeUndefined();
    // I-DR-SA2: per-repo isolation — only the 3 eligible repos invoke the primitive
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.repoPath)).toEqual([
      "/bare/ok-repo",
      "/bare/conflict-repo",
      "/bare/failed-repo",
    ]);
  });
});

describe("runDoltReconcileAcrossRepos — mode threading", () => {
  test("--push-only: per-repo primitive invoked with mode push-only; only commit + push run", async () => {
    const candidates = [eligibleRepo("a")];
    const { deps, output, calls } = makeDeps();
    const { exitCode, result } = await runDoltReconcileAcrossRepos(
      opts({ mode: "push-only", candidates }),
      output,
      deps,
    );
    expect(exitCode).toBe(0);
    expect(calls[0]?.mode).toBe("push-only");
    expect(result.perRepo[0]?.steps?.map((s) => s.step)).toEqual(["commit", "push"]);
    expect(result.mode).toBe("push-only");
  });

  test("--pull-only: only pull runs; mode reflected throughout", async () => {
    const candidates = [eligibleRepo("a")];
    const { deps, output, calls } = makeDeps();
    const { exitCode, result } = await runDoltReconcileAcrossRepos(
      opts({ mode: "pull-only", candidates }),
      output,
      deps,
    );
    expect(exitCode).toBe(0);
    expect(calls[0]?.mode).toBe("pull-only");
    expect(result.perRepo[0]?.steps?.map((s) => s.step)).toEqual(["pull"]);
    expect(result.mode).toBe("pull-only");
  });
});

describe("runDoltReconcileAcrossRepos — dry-run", () => {
  test("I-DR-SA1: every per-repo call is dry-run; produces preview-only steps", async () => {
    const candidates = [eligibleRepo("a"), eligibleRepo("b")];
    const { deps, output, calls } = makeDeps();
    const { exitCode, result } = await runDoltReconcileAcrossRepos(
      opts({ dryRun: true, candidates }),
      output,
      deps,
    );
    expect(exitCode).toBe(0);
    expect(calls.every((c) => c.dryRun === true)).toBe(true);
    // Preview steps render as `success` rows in the aggregate (preview is a
    // "no work performed but pipeline known" state).
    expect(result.perRepo.every((r) => r.status === "success")).toBe(true);
    expect(result.perRepo.every((r) => r.steps?.every((s) => s.status === "preview") ?? false)).toBe(true);
  });
});

describe("runDoltReconcileAcrossRepos — no-op detection", () => {
  test("reconciled with every step skipped → status no-op (not success)", async () => {
    const candidates = [eligibleRepo("a")];
    const { deps, output } = makeDeps({
      candidates,
      perRepoResults: {
        "/bare/a": {
          exitCode: 0,
          result: reconciled([skippedStep("commit"), okStep("pull"), okStep("push")]),
        },
      },
    });
    // commit-skipped but pull/push ok → still success (work happened).
    const r1 = await runDoltReconcileAcrossRepos(opts({ candidates }), output, deps);
    expect(r1.result.perRepo[0]?.status).toBe("success");

    const { deps: deps2, output: out2 } = makeDeps({
      candidates,
      perRepoResults: {
        "/bare/a": {
          exitCode: 0,
          result: reconciled([skippedStep("commit"), skippedStep("pull"), skippedStep("push")]),
        },
      },
    });
    const r2 = await runDoltReconcileAcrossRepos(opts({ candidates }), out2, deps2);
    expect(r2.result.perRepo[0]?.status).toBe("no-op");
  });
});

describe("runDoltReconcileAcrossRepos — primitive throw isolation", () => {
  test("a thrown error from the per-repo primitive becomes a failed row; walk proceeds", async () => {
    const candidates = [eligibleRepo("crash"), eligibleRepo("ok")];
    const { deps, output, calls } = makeDeps({
      candidates,
      perRepoResults: {
        "/bare/crash": new Error("spawn ENOENT bd"),
      },
    });
    const { exitCode, result } = await runDoltReconcileAcrossRepos(opts({ candidates }), output, deps);
    expect(exitCode).toBe(1);
    expect(result.perRepo[0]?.status).toBe("failed");
    expect(result.perRepo[0]?.error).toContain("spawn ENOENT bd");
    expect(result.perRepo[1]?.status).toBe("success");
    expect(calls).toHaveLength(2);
  });
});

describe("runDoltReconcileAcrossRepos — empty inventory", () => {
  test("empty candidate list → exit 0 and a friendly table", async () => {
    const { deps, output, logs } = makeDeps();
    const { exitCode, result } = await runDoltReconcileAcrossRepos(
      opts({ candidates: [] }),
      output,
      deps,
    );
    expect(exitCode).toBe(0);
    expect(result.perRepo).toHaveLength(0);
    expect(logs.join("\n")).toContain("no eligible repos");
  });

  test("missing inventory index → exit 1 with operator-actionable error", async () => {
    const { deps, output, errs } = makeDeps({
      loadCandidates: () => null,
    });
    // No `candidates` provided → orchestrator hits the loader path.
    const { exitCode } = await runDoltReconcileAcrossRepos(opts(), output, deps);
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no repo inventory index");
  });
});

describe("runDoltReconcileAcrossRepos — JSON format", () => {
  test("--format=json prints schema-validated JSON with stable shape", async () => {
    const candidates = [eligibleRepo("a"), skippedRepo("b", "no-remote", null)];
    const { deps, output, logs } = makeDeps({ candidates });
    const { result } = await runDoltReconcileAcrossRepos(
      opts({ candidates, format: "json" }),
      output,
      deps,
    );
    const parsed = JSON.parse(logs[logs.length - 1]!);
    expect(parsed.perRepo).toHaveLength(2);
    expect(parsed.perRepo[0].slug).toBe("a");
    expect(parsed.perRepo[1].skipReason).toBe("no-remote");
    expect(parsed.mode).toBe("full");
    expect(typeof parsed.tickStartedAt).toBe("string");
    expect(parsed.exitCode).toBe(0);
    // Sanity: round-trip equality with the orchestrator's typed result.
    expect(parsed.perRepo[0].slug).toBe(result.perRepo[0]!.slug);
  });
});

// ── CLI-layer tests (GH-1697 regression guard) ─────────────────────────────

function inventoryWith(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

function bareRepo(over: Partial<LocalRepo> & { name: string }): LocalRepo {
  const name = over.name;
  return {
    kind: "bare",
    commonDir: `/bare/${name}`,
    worktrees: [],
    primaryRemote: { remote: "origin", url: `git@github.com:bdelanghe/${name}.git`, githubRepo: `bdelanghe/${name}` },
    bd_workspace_prefix: name,
    dolt_remote: `https://doltremoteapi.dolthub.com/bdelanghe/${name}`,
    ...over,
    // `name` is intentionally last so it cannot be undone by a `name: undefined` override.
    name,
  } as LocalRepo;
}

function cliDepsForSyncAll(
  inventory: RepoInventory,
  state: BeadsStateForReconcile,
  beadsSyncAllAcrossRepos?: typeof runDoltReconcileAcrossRepos,
) {
  const cfg: RepoInventoryConfig = {
    repoRoot: "/repo",
    bareRoot: "/bare",
    roots: [],
    everywhereRoots: [],
    globalConfigPath: null,
    configPath: "/repo/.prx/repos/config.json",
    indexPath: "/repo/.prx/repos/index.json",
  };
  return {
    loadRepoInventoryConfig: () => cfg,
    loadRepoInventoryIndex: () => inventory,
    classifyBeadsWorkspace: (() =>
      // The CLI only consults `.kind` on the returned shape.
      ({ kind: state }) as never),
    ...(beadsSyncAllAcrossRepos ? { beadsSyncAllAcrossRepos } : {}),
  };
}

describe("prx beads sync-all CLI — --repo resolution (GH-1697 regression guard)", () => {
  test("--repo <unknown-slug> exits non-zero and runs zero reconciles (no cwd fallback)", async () => {
    const inventory = inventoryWith([bareRepo({ name: "ai-home" })]);
    const logs: string[] = [];
    const errs: string[] = [];
    let invoked = false;
    const fakeOrchestrator = (async () => {
      invoked = true;
      return { exitCode: 0, result: { perRepo: [], exitCode: 0, tickStartedAt: FIXED_NOW.toISOString(), mode: "full" as const } };
    }) as unknown as typeof runDoltReconcileAcrossRepos;
    const exit = await runCli(
      ["beads", "sync-all", "--repo", "nonsense", "--dry-run"],
      { log: (l) => logs.push(l), error: (l) => errs.push(l) },
      cliDepsForSyncAll(inventory, "per_project", fakeOrchestrator),
    );
    expect(exit).toBe(1);
    expect(invoked).toBe(false);
    expect(errs.join("\n")).toContain('--repo "nonsense" did not match');
  });

  test("--repo <known-slug> constrains to that single repo (cwd is never the source)", async () => {
    const inventory = inventoryWith([
      bareRepo({ name: "ai-home" }),
      bareRepo({ name: "demo-repo" }),
    ]);
    const observedCandidates: DoltReconcileCandidate[][] = [];
    const fakeOrchestrator = (async (o: RunDoltReconcileAcrossReposOptions) => {
      observedCandidates.push(o.candidates ?? []);
      return {
        exitCode: 0,
        result: {
          perRepo: (o.candidates ?? []).map((c) =>
            c.kind === "eligible"
              ? { slug: c.repo.slug, nameWithOwner: c.repo.nameWithOwner, status: "success" as const, mode: o.mode, steps: [] }
              : {
                  slug: c.slug,
                  nameWithOwner: c.nameWithOwner,
                  status: "skipped" as const,
                  skipReason: c.reason,
                  mode: o.mode,
                },
          ),
          exitCode: 0,
          tickStartedAt: FIXED_NOW.toISOString(),
          mode: o.mode,
        },
      };
    }) as unknown as typeof runDoltReconcileAcrossRepos;
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await runCli(
      ["beads", "sync-all", "--repo", "demo-repo", "--dry-run"],
      { log: (l) => logs.push(l), error: (l) => errs.push(l) },
      cliDepsForSyncAll(inventory, "per_project", fakeOrchestrator),
    );
    expect(exit).toBe(0);
    expect(observedCandidates).toHaveLength(1);
    const cands = observedCandidates[0]!;
    expect(cands).toHaveLength(1);
    expect(cands[0]?.kind === "eligible" && cands[0].repo.slug).toBe("demo-repo");
  });

  test("--repo <slug-without-dolt-remote> reports a single skipped:no-remote row (exit 0)", async () => {
    const inventory = inventoryWith([
      bareRepo({ name: "ai-home" }),
      // No dolt_remote on this repo.
      bareRepo({ name: "legacy", dolt_remote: undefined as unknown as string }),
    ]);
    let captured: DoltReconcileCandidate[] = [];
    const fakeOrchestrator = (async (o: RunDoltReconcileAcrossReposOptions) => {
      captured = o.candidates ?? [];
      return {
        exitCode: 0,
        result: {
          perRepo: [
            {
              slug: "legacy",
              nameWithOwner: "bdelanghe/legacy",
              status: "skipped" as const,
              skipReason: "no-remote" as const,
              mode: o.mode,
            },
          ],
          exitCode: 0,
          tickStartedAt: FIXED_NOW.toISOString(),
          mode: o.mode,
        },
      };
    }) as unknown as typeof runDoltReconcileAcrossRepos;
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await runCli(
      ["beads", "sync-all", "--repo", "legacy", "--dry-run"],
      { log: (l) => logs.push(l), error: (l) => errs.push(l) },
      cliDepsForSyncAll(inventory, "per_project", fakeOrchestrator),
    );
    expect(exit).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("skipped");
    if (captured[0]?.kind === "skipped") {
      expect(captured[0].reason).toBe("no-remote");
    }
  });
});

describe("prx beads sync-all CLI — flag parsing", () => {
  test("--push-only and --pull-only together are rejected before any reconcile", async () => {
    let invoked = false;
    const inventory = inventoryWith([bareRepo({ name: "ai-home" })]);
    const fakeOrchestrator = (async () => {
      invoked = true;
      return { exitCode: 0, result: { perRepo: [], exitCode: 0, tickStartedAt: FIXED_NOW.toISOString(), mode: "full" as const } };
    }) as unknown as typeof runDoltReconcileAcrossRepos;
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await runCli(
      ["beads", "sync-all", "--push-only", "--pull-only"],
      { log: (l) => logs.push(l), error: (l) => errs.push(l) },
      cliDepsForSyncAll(inventory, "per_project", fakeOrchestrator),
    );
    expect(exit).not.toBe(0);
    expect(invoked).toBe(false);
    expect(errs.join("\n")).toContain("mutually exclusive");
  });
});
