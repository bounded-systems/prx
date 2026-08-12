// GH-2262: `prx submit stage` producer — unit coverage with an injected git
// reader + a real (tmpdir) submit CAS, plus a producer→consumer round-trip that
// stages an artifact and confirms `prx submit publish --from-cas` reads it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { getRef } from "../../src/plan-store/cas.ts";
import { readSubmitArtifact, SUBMIT_DOMAIN } from "../../src/submit/artifact.schema.ts";
import {
  defaultGitReader,
  formatStageRender,
  resolveBaseCommit,
  runSubmitStage,
  StageError,
  type GitReader,
  type StageOptions,
} from "../../src/submit/stage.ts";

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_CAS_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
  "PRX_OPERATOR_CONFIG_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
  "XDG_STATE_HOME",
  "HOME",
] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const TREE_SHA = "a".repeat(40); // proposed working-state tree (≠ base tree)
const BASE_SHA = "b".repeat(40); // base commit — the fork point (merge base)
const BASE_TREE = "c".repeat(40); // tree the base commit points at
const HEAD_SHA = "d".repeat(40); // the unit branch tip
const STALE_LOCAL_SHA = "e".repeat(40); // local `main`, lagging origin/main

// GH-2381: stage reads the base commit + base tree; the proposed tree is
// materialized by keeper (injected via `materializeTree`).
// prx-3f1 / #119: the default fake models the BUG'S OWN SHAPE — a repo whose
// local `main` (STALE_LOCAL_SHA) lags `origin/main`, with the fork point
// (BASE_SHA) as the merge base. A base resolved correctly is BASE_SHA;
// resolving it from the local ref, as stage used to, yields STALE_LOCAL_SHA.
function fakeGit(overrides: Partial<GitReader> = {}): GitReader {
  return {
    revParse: (ref) => {
      if (ref.includes("^{tree}")) return BASE_TREE;
      return ref === "main" ? STALE_LOCAL_SHA : BASE_SHA;
    },
    tryRevParse: (ref) => (ref === "HEAD" ? HEAD_SHA : null),
    upstreamOf: (ref) => (ref === "main" ? "origin/main" : null),
    mergeBase: () => BASE_SHA,
    diff: () => "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
    ...overrides,
  };
}

/** Fake keeper tree-materializer; defaults to a proposed tree ≠ base tree. */
function fakeMaterializeTree(sha: string = TREE_SHA): () => Promise<string> {
  return () => Promise.resolve(sha);
}

function deps(over: { git?: Partial<GitReader>; treeSha?: string } = {}) {
  return {
    git: fakeGit(over.git),
    materializeTree: fakeMaterializeTree(over.treeSha),
  };
}

function opts(o: Partial<StageOptions> = {}): StageOptions {
  return {
    workUnitId: "GH-2262",
    slot: "ready",
    baseRef: "main",
    dryRun: false,
    format: "json",
    ...o,
  };
}

describe("runSubmitStage (GH-2262)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-stage-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("stages a ready artifact: writes patch + metadata, advances the ref", async () => {
    const render = await runSubmitStage(opts(), deps());

    expect(render.ref).toBe("GH-2262:submit@ready");
    expect(render.exitCode).toBe(0);
    expect(render.dryRun).toBe(false);
    expect(render.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(render.patch.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(render.patch.bytes).toBeGreaterThan(0);

    // The ready ref now resolves to the artifact metadata sha.
    const stored = await getRef("GH-2262:submit@ready", { domain: SUBMIT_DOMAIN });
    expect(stored).toBe(render.sha!);

    // The stored artifact round-trips and is well-formed.
    const art = await readSubmitArtifact({ sha: render.sha! });
    expect(art.workUnitId).toBe("GH-2262");
    // prx-3f1 / #119: baseRef stays the BRANCH (publish opens the PR against
    // it); baseSha is the merge base with origin/main, never the local ref.
    expect(art.baseRef).toBe("main");
    expect(art.baseSha).toBe(BASE_SHA);
    expect(art.baseSha).not.toBe(STALE_LOCAL_SHA);
    // GH-2381: identity is the keeper-materialized tree SHA — no stored head.
    expect(art.tree).toEqual({ sha: TREE_SHA });
    expect((art as Record<string, unknown>).head).toBeUndefined();
    expect(art.summary).toBe("Submit GH-2262"); // synthetic default
    expect(art.patch).toEqual({ sha: render.patch.sha!, bytes: render.patch.bytes });
  });

  test("--summary overrides the synthetic default", async () => {
    const render = await runSubmitStage(opts({ summary: "custom summary" }), deps());
    const art = await readSubmitArtifact({ sha: render.sha! });
    expect(art.summary).toBe("custom summary");
  });

  test("draft slot writes the draft ref", async () => {
    const render = await runSubmitStage(opts({ slot: "draft" }), deps());
    expect(render.ref).toBe("GH-2262:submit@draft");
    const stored = await getRef("GH-2262:submit@draft", { domain: SUBMIT_DOMAIN });
    expect(stored).toBe(render.sha!);
  });

  test("dry run computes the plan but writes nothing to the CAS", async () => {
    const render = await runSubmitStage(opts({ dryRun: true }), deps());

    expect(render.dryRun).toBe(true);
    expect(render.sha).toBeUndefined();
    expect(render.patch.sha).toBeUndefined();
    expect(render.patch.bytes).toBeGreaterThan(0);
    expect(render.tree.sha).toBe(TREE_SHA);

    const stored = await getRef("GH-2262:submit@ready", { domain: SUBMIT_DOMAIN });
    expect(stored).toBeNull();
  });

  test("throws when the working tree matches base (nothing to submit)", async () => {
    let caught: unknown;
    try {
      // Keeper materializes a tree identical to the base tree → no-op.
      await runSubmitStage(opts(), deps({ treeSha: BASE_TREE }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StageError);
    expect((caught as Error).message).toMatch(/nothing to submit/);
  });

  test("long summary is truncated to the schema's 500-char cap", async () => {
    const render = await runSubmitStage(opts({ summary: "x".repeat(800) }), deps());
    const art = await readSubmitArtifact({ sha: render.sha! });
    expect(art.summary.length).toBe(500);
  });
});

// prx-3f1 / #119: the base was resolved with `rev-parse <baseRef>` — the LOCAL
// branch ref. Local `main` drifts from `origin/main` during a long
// orchestration or an external push, in EITHER direction, and each direction
// corrupts the patch its own way: a local ref that lags folds the intervening
// main commits into the patch as additions; one that leads renders them as
// reverts (the 76KB/34-file patch that surfaced this). The merge base with the
// remote-tracking ref is the fork point, and immune to both.
describe("base resolution (prx-3f1 / #119)", () => {
  test("bases the patch on the merge base with origin/main, not the local ref", async () => {
    const diffedFrom: string[] = [];
    const render = await runSubmitStage(
      opts({ dryRun: true }),
      deps({ git: { diff: (from) => (diffedFrom.push(from), "patch\n") } }),
    );

    expect(render.baseSha).toBe(BASE_SHA);
    expect(render.baseSha).not.toBe(STALE_LOCAL_SHA); // what `rev-parse main` gives
    expect(render.baseResolvedFrom).toBe("origin/main");
    expect(render.baseVia).toBe("merge-base");
    expect(diffedFrom).toEqual([BASE_SHA]);
  });

  test("prefers the branch's configured upstream over the origin/ guess", () => {
    const base = resolveBaseCommit(
      "main",
      fakeGit({ upstreamOf: () => "upstream/main", mergeBase: () => BASE_SHA }),
    );
    expect(base.resolvedFrom).toBe("upstream/main");
  });

  test("guesses origin/<base> when the branch has no configured upstream", () => {
    const base = resolveBaseCommit(
      "main",
      fakeGit({
        upstreamOf: () => null,
        tryRevParse: (ref) => (ref === "HEAD" ? HEAD_SHA : ref === "origin/main" ? BASE_SHA : null),
      }),
    );
    expect(base.resolvedFrom).toBe("origin/main");
    expect(base.sha).toBe(BASE_SHA);
  });

  test("falls back to the local ref when the repo has no remote-tracking branch", () => {
    const base = resolveBaseCommit(
      "main",
      fakeGit({ upstreamOf: () => null, tryRevParse: (ref) => (ref === "HEAD" ? HEAD_SHA : null) }),
    );
    expect(base.resolvedFrom).toBe("main");
  });

  test("an explicitly remote --base is not origin/-prefixed twice", () => {
    const probed: string[] = [];
    const base = resolveBaseCommit(
      "origin/main",
      fakeGit({
        upstreamOf: () => null,
        tryRevParse: (ref) => (probed.push(ref), ref === "HEAD" ? HEAD_SHA : null),
      }),
    );
    expect(base.resolvedFrom).toBe("origin/main");
    expect(probed).toContain("origin/origin/main"); // probed…
    expect(base.resolvedFrom).not.toContain("origin/origin"); // …and not adopted
  });

  test("falls back to the tip when the revs share no history", () => {
    const base = resolveBaseCommit("main", fakeGit({ mergeBase: () => null }));
    expect(base.via).toBe("tip");
    expect(base.sha).toBe(BASE_SHA); // rev-parse origin/main
  });

  test("falls back to the tip when HEAD is unborn", () => {
    const base = resolveBaseCommit("main", fakeGit({ tryRevParse: () => null }));
    expect(base.via).toBe("tip");
    expect(base.resolvedFrom).toBe("origin/main");
  });
});

describe("formatStageRender (GH-2262)", () => {
  test("plain render shows the next publish command after a real stage", async () => {
    const render = await (async () => {
      const casRoot = mkdtempSync(join(tmpdir(), "prx-submit-stage-fmt-"));
      const snap = snapshotEnv();
      for (const k of ENV_KEYS) delete process.env[k];
      process.env.PRX_CAS_ROOT = casRoot;
      try {
        return await runSubmitStage(opts({ format: "plain" }), deps());
      } finally {
        restoreEnv(snap);
      }
    })();
    const text = formatStageRender(render, "plain");
    expect(text).toContain("GH-2262:submit@ready");
    expect(text).toContain("prx submit publish --from-cas GH-2262:submit@ready");
  });

  test("plain dry-run render flags that nothing was written", () => {
    const text = formatStageRender(
      {
        workUnitId: "GH-2262",
        slot: "ready",
        ref: "GH-2262:submit@ready",
        baseRef: "main",
        baseSha: BASE_SHA,
        baseResolvedFrom: "origin/main",
        baseVia: "merge-base",
        tree: { sha: TREE_SHA },
        patch: { bytes: 42 },
        summary: "feat: producer verb",
        createdAt: "2026-05-26T00:00:00.000Z",
        dryRun: true,
        exitCode: 0,
      },
      "plain",
    );
    expect(text).toContain("DRY RUN");
    expect(text).toContain("nothing written");
  });
});

// The fakes above pin the POLICY (which rev is chosen); this pins the
// MECHANISM against real git — that `defaultGitReader.mergeBase`, spelled with
// `log --boundary` because `merge-base` is not on execGit's allowlist, actually
// returns the fork point. Each test also computes the OLD answer
// (`rev-parse main`) and asserts the patch it produces is the bloated one, so a
// green here is evidence the setup reproduces #119, not just that stage runs.
describe("base resolution against real git (prx-3f1 / #119)", () => {
  interface Fixture {
    /** The unit worktree: unit branch checked out, `origin/main` fetched. */
    work: string;
    /** The fork point the unit branched from — the correct base. */
    fork: string;
    /** What `rev-parse main` (the old resolution) returns in `work`. */
    localMain: string;
    /** Tree of the unit's working state — what keeper would materialize. */
    unitTree: string;
  }

  /**
   * A repo with a real remote, an out-of-date local `main`, and `origin/main`
   * advanced by someone else — the shape #119 was reported from.
   *
   * `localMainLeads` picks the drift direction: `true` fast-forwards local
   * `main` past the fork point (the reported symptom — intervening commits show
   * up as REVERTS), `false` leaves it at the fork point while `origin/main`
   * moves ahead (the title's "stale local main" — they show up as ADDITIONS).
   */
  function fixture(localMainLeads: boolean): Fixture {
    const root = mkdtempSync(join(tmpdir(), "prx-stage-basefix-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const other = join(root, "other");
    const git = (cwd: string, ...args: string[]): string => {
      const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
      return res.stdout.trim();
    };
    const commit = (cwd: string, file: string, body: string): void => {
      writeFileSync(join(cwd, file), body);
      git(cwd, "add", "-A");
      git(
        cwd,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        file,
      );
    };

    spawnSync("git", ["init", "--bare", "-b", "main", remote]);
    spawnSync("git", ["clone", remote, work], { encoding: "utf8" });
    commit(work, "a.txt", "a\n");
    git(work, "push", "-u", "origin", "main");
    const fork = git(work, "rev-parse", "HEAD");

    // The unit is cut from the fork point and does its own work.
    git(work, "switch", "-c", "unit");
    commit(work, "unit.txt", "the unit's only change\n");
    const unitTree = git(work, "rev-parse", "HEAD^{tree}");

    // Meanwhile, someone else merges to origin/main: the "community templates +
    // coverage.yml" of the report.
    spawnSync("git", ["clone", remote, other], { encoding: "utf8" });
    commit(other, "coverage.yml", "unrelated main-side change\n");
    commit(other, "templates.md", "also unrelated\n");
    git(other, "push", "origin", "main");

    git(work, "fetch", "origin");
    if (localMainLeads) {
      git(work, "switch", "main");
      git(work, "merge", "--ff-only", "origin/main");
      git(work, "switch", "unit");
    }
    return { work, fork, localMain: git(work, "rev-parse", "main"), unitTree };
  }

  const patchFrom = (cwd: string, base: string, tree: string): string => {
    const res = spawnSync("git", ["-C", cwd, "diff", base, tree], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return res.stdout;
  };

  test("local main LEADS the unit: old base reverts main's commits, merge base does not", () => {
    const fx = fixture(true);
    expect(fx.localMain).not.toBe(fx.fork); // the drift is real

    const base = resolveBaseCommit("main", defaultGitReader, fx.work);
    expect(base.sha).toBe(fx.fork);
    expect(base.resolvedFrom).toBe("origin/main");
    expect(base.via).toBe("merge-base");

    // The bug, as reported: unrelated main-side files deleted by the patch.
    const old = patchFrom(fx.work, fx.localMain, fx.unitTree);
    expect(old).toContain("coverage.yml");
    expect(old).toContain("templates.md");

    // The fix: ONLY the unit's change.
    const fixed = patchFrom(fx.work, base.sha, fx.unitTree);
    expect(fixed).toContain("unit.txt");
    expect(fixed).not.toContain("coverage.yml");
    expect(fixed).not.toContain("templates.md");
  });

  test("local main LAGS origin/main: base is still the fork point", () => {
    const fx = fixture(false);
    const base = resolveBaseCommit("main", defaultGitReader, fx.work);

    // Here the local ref happens to sit ON the fork point, so the patch is not
    // bloated — but the base must come from the remote-tracking ref by way of
    // the merge base, or the next push past it silently reintroduces #119.
    expect(base.sha).toBe(fx.fork);
    expect(base.resolvedFrom).toBe("origin/main");
    expect(base.via).toBe("merge-base");
    expect(base.sha).not.toBe(defaultGitReader.revParse("origin/main", fx.work));

    const fixed = patchFrom(fx.work, base.sha, fx.unitTree);
    expect(fixed).toContain("unit.txt");
    expect(fixed).not.toContain("coverage.yml");
  });

  test("a repo with no remote falls back to the local ref rather than failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-stage-noremote-"));
    spawnSync("git", ["init", "-b", "main", dir]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "c1",
    ]);

    const base = resolveBaseCommit("main", defaultGitReader, dir);
    expect(base.resolvedFrom).toBe("main");
    expect(base.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("prx submit stage CLI wiring (GH-2262)", () => {
  test("missing work-unit positional → non-zero exit with hint", async () => {
    const errors: string[] = [];
    const exit = await runCli(
      ["submit", "stage"],
      { log: () => {}, error: (line: string) => errors.push(line) },
      {},
    );
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("requires a <work-unit-id>"))).toBe(true);
  });

  test("invalid --slot → non-zero exit", async () => {
    const errors: string[] = [];
    const exit = await runCli(
      ["submit", "stage", "GH-2262", "--slot", "bogus"],
      { log: () => {}, error: (line: string) => errors.push(line) },
      {},
    );
    expect(exit).not.toBe(0);
  });
});

describe("stage → publish round-trip (GH-2262 producer feeds GH-1900 consumer)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-stage-rt-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("staged ready artifact is read back by `submit publish --from-cas --dry-run`", async () => {
    await runSubmitStage(opts({ slot: "ready" }), deps());

    const logs: string[] = [];
    const errors: string[] = [];
    const exit = await runCli(
      ["submit", "publish", "--from-cas", "GH-2262:submit@ready", "--dry-run", "--format", "json"],
      { log: (l: string) => logs.push(l), error: (e: string) => errors.push(e) },
      {},
    );

    expect(errors).toEqual([]);
    expect(exit).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      artifact: { workUnitId: string; tree: { sha: string } };
      steps: Array<{ kind: string; ref?: string }>;
    };
    expect(parsed.artifact.workUnitId).toBe("GH-2262");
    expect(parsed.artifact.tree.sha).toBe(TREE_SHA);
    expect(parsed.steps.map((s) => s.kind)).toEqual([
      "preflight",
      "keeper-commit",
      "keeper-push",
      "publisher-pr-open",
      "set-ref",
    ]);
    expect(parsed.steps.find((s) => s.kind === "set-ref")?.ref).toBe("GH-2262:submit@published");
  });

  test("GH-2267: `submit publish` defaults to draft; `--ready` opts out", async () => {
    await runSubmitStage(opts({ slot: "ready" }), deps());

    // The publisher-pr-open plan step flags draft vs ready in its detail.
    const prDetail = async (extra: string[]): Promise<string> => {
      const logs: string[] = [];
      const exit = await runCli(
        [
          "submit",
          "publish",
          "--from-cas",
          "GH-2262:submit@ready",
          "--dry-run",
          "--format",
          "json",
          ...extra,
        ],
        { log: (l: string) => logs.push(l), error: () => {} },
        {},
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(logs[0]!) as {
        steps: Array<{ kind: string; detail?: string }>;
      };
      return parsed.steps.find((s) => s.kind === "publisher-pr-open")?.detail ?? "";
    };

    expect(await prDetail([])).toContain("(draft)");
    expect(await prDetail(["--ready"])).not.toContain("(draft)");
  });
});
