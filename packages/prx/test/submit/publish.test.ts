// GH-1900 / GH-2348.2: `prx submit publish` orchestrates a CAS artifact →
// keeper push + publisher PR-open + ref-advance. The push/PR side effects are
// delegated (keeper, publisher) and injected here as seams; the orchestrator
// only runs the parity preflight (via `runner`) and advances the slot.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getRef } from "../../src/plan-store/cas.ts";
import {
  SUBMIT_DOMAIN,
  writeSubmitArtifact,
  type SubmitArtifact,
} from "../../src/submit/artifact.schema.ts";
import {
  PublishError,
  runSubmitPublish,
  type PublishDeps,
} from "../../src/submit/publish.ts";

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_CAS_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
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

const HEX40 = "1234567890abcdef1234567890abcdef12345678";
const HEX64 = "0".repeat(64);

const MATERIALIZED_COMMIT = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

function validArtifact(overrides: Partial<SubmitArtifact> = {}): SubmitArtifact {
  return {
    workUnitId: "GH-1900",
    baseRef: "main",
    baseSha: HEX40,
    tree: { sha: HEX40 },
    patch: { sha: `sha256:${HEX64}`, bytes: 0 },
    summary: "publish handoff",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

/** Preflight runner result (the `prx chain check-issue` call). */
function ok(): SpawnSyncReturns<string> {
  return { pid: 1, status: 0, signal: null, stdout: "", stderr: "", output: ["", "", ""] };
}
function fail(stderr: string, status = 1): SpawnSyncReturns<string> {
  return { pid: 1, status, signal: null, stdout: "", stderr, output: ["", "", stderr] };
}

/**
 * Records the delegated calls so tests can assert orchestration order/args
 * without real git/gh. `keeperPush` returns a `GitExecResult`; `prOpen` an exit
 * code. Both default to success.
 */
function spy(
  over: {
    pushExit?: number;
    pushStderr?: string;
    prExit?: number;
    runner?: PublishDeps["runner"];
  } = {},
): {
  deps: PublishDeps;
  preflight: Array<{ cmd: string; args: string[] }>;
  commits: Array<{ treeSha: string; parentSha: string; branch: string }>;
  pushes: string[][];
  prOpens: Array<{ workUnitId: string; summary: string; head: string | undefined; base: string | undefined; ready: boolean | undefined }>;
} {
  const preflight: Array<{ cmd: string; args: string[] }> = [];
  const commits: Array<{ treeSha: string; parentSha: string; branch: string }> = [];
  const pushes: string[][] = [];
  const prOpens: Array<{ workUnitId: string; summary: string; head: string | undefined; base: string | undefined; ready: boolean | undefined }> = [];
  const deps: PublishDeps = {
    runner:
      over.runner ??
      ((cmd, args) => {
        preflight.push({ cmd, args });
        return ok();
      }),
    // GH-2381: keeper materializes the publishable commit from the tree artifact.
    async commitTree(input) {
      commits.push({ treeSha: input.treeSha, parentSha: input.parentSha, branch: input.branch });
      return MATERIALIZED_COMMIT;
    },
    async keeperPush(args) {
      pushes.push(args);
      return {
        exitCode: over.pushExit ?? 0,
        stdout: "",
        stderr: over.pushStderr ?? "",
        policy: null,
      };
    },
    prOpen(target, options) {
      prOpens.push({
        workUnitId: target.workUnitId,
        summary: options.summary,
        head: options.head,
        base: options.base,
        ready: options.ready,
      });
      return over.prExit ?? 0;
    },
  };
  return { deps, preflight, commits, pushes, prOpens };
}

describe("runSubmitPublish (GH-1900 / GH-2348.2)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-publish-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("dry-run resolves the ref → sha and prints the keeper+publisher plan without delegating", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, preflight, commits, pushes, prOpens } = spy();
    const render = await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: true, ready: false, format: "plain" },
      deps,
    );
    expect(preflight).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
    expect(render.dryRun).toBe(true);
    expect(render.exitCode).toBe(0);
    expect(render.artifact.workUnitId).toBe("GH-1900");
    expect(render.steps.map((s) => s.kind)).toEqual([
      "preflight",
      "keeper-commit",
      "keeper-push",
      "publisher-pr-open",
      "set-ref",
    ]);
    const push = render.steps.find((s) => s.kind === "keeper-push");
    expect(push?.argv).toEqual(["prx", "keeper", "push", "origin", "GH-1900"]);
    // Draft is the default → the plan detail flags it.
    const pr = render.steps.find((s) => s.kind === "publisher-pr-open");
    expect(pr?.detail).toContain("(draft)");
  });

  test("GH-2267: draft by default — prOpen is called with ready:false", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
      deps,
    );
    expect(prOpens).toHaveLength(1);
    expect(prOpens[0]!.ready).toBe(false);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBe(sha);
  });

  test("GH-2267: --ready opts out of draft — prOpen is called with ready:true", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: true, format: "plain" },
      deps,
    );
    expect(prOpens[0]!.ready).toBe(true);
  });

  test("non-dry-run runs preflight → keeper commit → keeper push → publisher pr-open → setRef(:published)", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, preflight, commits, pushes, prOpens } = spy();

    const render = await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
      deps,
    );

    expect(render.exitCode).toBe(0);
    // Preflight is the only `runner` call; commit/push + PR are delegated.
    expect(preflight).toHaveLength(1);
    expect(preflight[0]!.cmd).toBe("prx");
    expect(preflight[0]!.args).toEqual(["chain", "check-issue", "GH-1900"]);
    // GH-2381: keeper materializes the commit from the tree + base, branch GH-<n>.
    expect(commits).toEqual([{ treeSha: HEX40, parentSha: HEX40, branch: "GH-1900" }]);
    expect(pushes).toEqual([["origin", "GH-1900"]]);
    expect(prOpens).toEqual([
      { workUnitId: "GH-1900", summary: "publish handoff", head: "GH-1900", base: "main", ready: false },
    ]);

    // The published-slot ref now points at the artifact metadata sha.
    const published = await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN });
    expect(published).toBe(sha);
  });

  test("accepts a raw sha256:… handle, skips the ref resolve", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    const render = await runSubmitPublish(
      { fromCas: sha, dryRun: true, ready: false, format: "plain" },
      deps,
    );
    expect(render.resolvedSha).toBe(sha);
  });

  test("missing ref → PublishError with a clear hint", async () => {
    const { deps } = spy();
    await expect(
      runSubmitPublish(
        { fromCas: "GH-9999:submit@ready", dryRun: true, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);
  });

  test("malformed ref shape → PublishError before any delegation", async () => {
    const { deps, preflight, pushes, prOpens } = spy();
    await expect(
      runSubmitPublish(
        { fromCas: "GH-1:notsubmit@draft", dryRun: true, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toThrow();
    expect(preflight).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
  });

  test("preflight failure stops the pipeline; no push, no PR, ref unchanged", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, pushes, prOpens } = spy({
      runner: (cmd) => (cmd === "prx" ? fail("chain check-issue: parity drift") : ok()),
    });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("keeper push failure does not open a PR or advance the published ref", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy({ pushExit: 1, pushStderr: "rejected: tip is behind" });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    expect(prOpens).toHaveLength(0);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("publisher pr-open failure does not advance the published ref", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, pushes } = spy({ prExit: 1 });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    // The push ran (side effect happened) but the slot is not advanced.
    expect(pushes).toEqual([["origin", "GH-1900"]]);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });
});
