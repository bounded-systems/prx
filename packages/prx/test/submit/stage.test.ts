// GH-2262: `prx submit stage` producer — unit coverage with an injected git
// reader + a real (tmpdir) submit CAS, plus a producer→consumer round-trip that
// stages an artifact and confirms `prx submit publish --from-cas` reads it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { getRef } from "../../src/plan-store/cas.ts";
import {
  readSubmitArtifact,
  SUBMIT_DOMAIN,
} from "../../src/submit/artifact.schema.ts";
import {
  formatStageRender,
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
const BASE_SHA = "b".repeat(40); // base commit
const BASE_TREE = "c".repeat(40); // tree the base commit points at

// GH-2381: stage reads the base commit + base tree; the proposed tree is
// materialized by keeper (injected via `materializeTree`).
function fakeGit(overrides: Partial<GitReader> = {}): GitReader {
  return {
    revParse: (ref) => (ref.includes("^{tree}") ? BASE_TREE : BASE_SHA),
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
    expect(art.baseRef).toBe("main");
    expect(art.baseSha).toBe(BASE_SHA);
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
      [
        "submit",
        "publish",
        "--from-cas",
        "GH-2262:submit@ready",
        "--dry-run",
        "--format",
        "json",
      ],
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
    expect(parsed.steps.find((s) => s.kind === "set-ref")?.ref).toBe(
      "GH-2262:submit@published",
    );
  });

  test("GH-2267: `submit publish` defaults to draft; `--ready` opts out", async () => {
    await runSubmitStage(opts({ slot: "ready" }), deps());

    // The publisher-pr-open plan step flags draft vs ready in its detail.
    const prDetail = async (extra: string[]): Promise<string> => {
      const logs: string[] = [];
      const exit = await runCli(
        ["submit", "publish", "--from-cas", "GH-2262:submit@ready", "--dry-run", "--format", "json", ...extra],
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
