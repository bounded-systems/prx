// GH-1275 (PR-3 of GH-1261): per-run machine transition coverage.
//
// Each test injects fake actors via `depResearchMachine.provide({ actors })`
// so the state graph runs without touching disk, git, or curl. Asserts the
// invariant from the issue body (I-DR1: classification === "none" routes to
// `no_delta`, not `reporting`) and the DEP_* event emit sequence.

import { describe, expect, test } from "bun:test";
import { createActor, fromPromise } from "xstate";

import { depResearchMachine } from "../../src/dep-research/machine.ts";
import type {
  BuildAndWriteSnapshotActorInput,
  BuildAndWriteSnapshotActorResult,
  FetchSourceActorInput,
  LoadPrevAndDiffActorInput,
} from "../../src/dep-research/actors.ts";
import type { FetchResult } from "../../src/dep-research/fetch.ts";
import type { DepDelta, DepManifestEntry, DepSnapshot } from "../../src/dep-research/schemas.ts";

// ── builders ───────────────────────────────────────────────────────────────

function entry(overrides: Partial<DepManifestEntry> = {}): DepManifestEntry {
  return {
    name: "xstate",
    source: {
      kind: "git",
      url: "https://github.com/statelyai/xstate",
      paths: ["packages/core/src/types.ts"],
    },
    classification_hints: {
      schema: ["types\\.ts$"],
      state: [],
      cli: [],
      config: [],
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<DepSnapshot> = {}): DepSnapshot {
  return {
    dep: "xstate",
    run_id: "20260102T000000Z",
    fetched_at: "2026-01-02T00:00:00.000Z",
    source_sha256: { "packages/core/src/types.ts": "a".repeat(64) },
    source_byte_len: { "packages/core/src/types.ts": 1 },
    run_state: "ok",
    ...overrides,
  };
}

const fakeFetchOk = fromPromise<FetchResult, FetchSourceActorInput>(async () => ({
  paths: { "packages/core/src/types.ts": Buffer.from("x") },
  failures: {},
}));

function fakeBuildAndWrite(snap: DepSnapshot) {
  return fromPromise<BuildAndWriteSnapshotActorResult, BuildAndWriteSnapshotActorInput>(
    async () => ({
      snapshot: snap,
      path: `/tmp/${snap.dep}/${snap.run_id}`,
    }),
  );
}

function fakeLoadPrevAndDiff(delta: DepDelta) {
  return fromPromise<DepDelta, LoadPrevAndDiffActorInput>(async () => delta);
}

const fakeFetchFail = fromPromise<FetchResult, FetchSourceActorInput>(async () => {
  throw new Error("fetch boom");
});

function makeInput() {
  return {
    entry: entry(),
    runId: "20260102T000000Z",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    scratchDir: "/tmp/scratch",
    baseDir: "/tmp/base",
  };
}

function waitForFinal(actor: ReturnType<typeof createActor>): Promise<void> {
  return new Promise((resolve) => {
    if (actor.getSnapshot().status === "done") {
      resolve();
      return;
    }
    actor.subscribe((s) => {
      if (s.status === "done") resolve();
    });
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("depResearchMachine — happy path", () => {
  test("material delta routes to `reporting`", async () => {
    const delta: DepDelta = {
      dep: "xstate",
      prev_run_id: "20260101T000000Z",
      curr_run_id: "20260102T000000Z",
      classification: "schema",
      changes: [{ path: "packages/core/src/types.ts", kind: "modified", excerpt: "" }],
    };
    const snap = snapshot();
    const machine = depResearchMachine.provide({
      actors: {
        fetchSourceActor: fakeFetchOk,
        buildAndWriteSnapshotActor: fakeBuildAndWrite(snap),
        loadPrevAndDiffActor: fakeLoadPrevAndDiff(delta),
      },
    });
    const actor = createActor(machine, { input: makeInput() });
    actor.start();
    await waitForFinal(actor);
    const final = actor.getSnapshot();
    expect(final.value).toBe("reporting");
    expect(final.context.delta?.classification).toBe("schema");
    expect(final.context.snapshot?.dep).toBe("xstate");
    expect(final.context.blockedReason).toBeNull();
  });
});

describe("depResearchMachine — I-DR1 short-circuit", () => {
  test("classification === 'none' routes to `no_delta`, not `reporting`", async () => {
    const delta: DepDelta = {
      dep: "xstate",
      prev_run_id: "20260101T000000Z",
      curr_run_id: "20260102T000000Z",
      classification: "none",
      changes: [],
    };
    const snap = snapshot();
    const machine = depResearchMachine.provide({
      actors: {
        fetchSourceActor: fakeFetchOk,
        buildAndWriteSnapshotActor: fakeBuildAndWrite(snap),
        loadPrevAndDiffActor: fakeLoadPrevAndDiff(delta),
      },
    });
    const actor = createActor(machine, { input: makeInput() });
    actor.start();
    await waitForFinal(actor);
    const final = actor.getSnapshot();
    expect(final.value).toBe("no_delta");
    expect(final.context.delta?.classification).toBe("none");
  });
});

describe("depResearchMachine — failure path", () => {
  test("fetcher rejection routes to `failed` and records blockedReason", async () => {
    const machine = depResearchMachine.provide({
      actors: {
        fetchSourceActor: fakeFetchFail,
        buildAndWriteSnapshotActor: fakeBuildAndWrite(snapshot()),
        loadPrevAndDiffActor: fakeLoadPrevAndDiff({
          dep: "xstate",
          prev_run_id: null,
          curr_run_id: "20260102T000000Z",
          classification: "none",
          changes: [],
        }),
      },
    });
    const actor = createActor(machine, { input: makeInput() });
    actor.start();
    await waitForFinal(actor);
    const final = actor.getSnapshot();
    expect(final.value).toBe("failed");
    expect(final.context.blockedReason?.actor).toBe("fetchSource");
    expect(final.context.blockedReason?.message).toContain("fetch boom");
  });
});

describe("depResearchMachine — DEP_* event emits", () => {
  test("emits DEP_RESEARCH_REQUESTED and DEP_DELTA_CLASSIFIED on material delta", async () => {
    const delta: DepDelta = {
      dep: "xstate",
      prev_run_id: null,
      curr_run_id: "20260102T000000Z",
      classification: "schema",
      changes: [{ path: "x.ts", kind: "added", excerpt: "" }],
    };
    const machine = depResearchMachine.provide({
      actors: {
        fetchSourceActor: fakeFetchOk,
        buildAndWriteSnapshotActor: fakeBuildAndWrite(snapshot()),
        loadPrevAndDiffActor: fakeLoadPrevAndDiff(delta),
      },
    });
    const actor = createActor(machine, { input: makeInput() });

    const events: string[] = [];
    actor.on("*", (event) => events.push(event.type));

    actor.start();
    await waitForFinal(actor);

    expect(events).toContain("DEP_RESEARCH_REQUESTED");
    expect(events).toContain("DEP_FETCH_COMPLETED");
    expect(events).toContain("DEP_SNAPSHOT_WRITTEN");
    expect(events).toContain("DEP_DIFF_COMPUTED");
    expect(events).toContain("DEP_DELTA_CLASSIFIED");
    expect(events).not.toContain("DEP_RESEARCH_NO_DELTA");
  });

  test("emits DEP_RESEARCH_NO_DELTA on classification 'none' (not DEP_DELTA_CLASSIFIED)", async () => {
    const delta: DepDelta = {
      dep: "xstate",
      prev_run_id: "20260101T000000Z",
      curr_run_id: "20260102T000000Z",
      classification: "none",
      changes: [],
    };
    const machine = depResearchMachine.provide({
      actors: {
        fetchSourceActor: fakeFetchOk,
        buildAndWriteSnapshotActor: fakeBuildAndWrite(snapshot()),
        loadPrevAndDiffActor: fakeLoadPrevAndDiff(delta),
      },
    });
    const actor = createActor(machine, { input: makeInput() });

    const events: string[] = [];
    actor.on("*", (event) => events.push(event.type));

    actor.start();
    await waitForFinal(actor);

    expect(events).toContain("DEP_RESEARCH_NO_DELTA");
    expect(events).not.toContain("DEP_DELTA_CLASSIFIED");
  });
});
