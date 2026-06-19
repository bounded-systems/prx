// XState v5 per-run machine for `prx dep research <dep>` (GH-1275, PR-3 of
// GH-1261).
//
// Lifecycle: idle → fetching → snapshotting → diffing → classifying →
// (reporting | no_delta) | failed. Each invoke wraps a Zod-typed
// `fromPromise` actor in src/dep-research/actors.ts; tests swap actors via
// `depResearchMachine.provide({ actors })` rather than mocking modules.
//
// `reporting` is a deliberate seam: PR-4 (GH-1276) replaces this `final`
// state with an invoked `fileIssueActor` so the GH-issue filing path slots
// in without churning the rest of the state graph.
//
// Companion to `triageMachine` (src/triage/machine.ts) and `prSystem`
// (src/machine/machines/pr.ts). DEP_* events are emitted on entry to each
// downstream state so observers (audit log, future TUI) can track per-run
// progress without depending on the actor result types.

import { assign, emit, setup } from "xstate";

import { buildAndWriteSnapshotActor, fetchSourceActor, loadPrevAndDiffActor } from "./actors.ts";
import type { FetchResult, FetchSourceFn } from "./fetch.ts";
import type { DepDelta, DepManifestEntry, DepSnapshot } from "./schemas.ts";

// ── machine input + context ────────────────────────────────────────────────

export type DepResearchMachineInput = {
  /** Manifest entry for the dep being researched (already Zod-validated). */
  entry: DepManifestEntry;
  /** Compact UTC run-id; see `formatRunId` in src/dep-research/snapshot.ts. */
  runId: string;
  /** RFC 3339 timestamp matching `runId`'s clock. */
  fetchedAt: string;
  /** Scratch directory for the fetch step (cleaned up by the caller). */
  scratchDir: string;
  /**
   * Where to materialize the snapshot tree. Production = `<repoRoot>/.prx/
   * dep-research`; dry-run = an mktemp dir the caller deletes on exit
   * (preserves I-DR4 — see src/machine/state.ts:invariantSpecs).
   */
  baseDir: string;
  /**
   * Optional fetcher override. Defaults to `defaultFetchSource()` inside the
   * fetch actor. The seam exists so the GH-1245 fetch-actor swap is a
   * one-line change at the call site.
   */
  fetcher?: FetchSourceFn;
};

export type DepResearchBlockedReason = {
  /** Name of the actor whose invoke rejected. */
  actor: string;
  /** Original rejection message. */
  message: string;
};

export type DepResearchMachineContext = {
  // ── seeded from input ────────────────────────────────────────────────────
  entry: DepManifestEntry;
  runId: string;
  fetchedAt: string;
  scratchDir: string;
  baseDir: string;
  fetcher: FetchSourceFn | undefined;
  // ── populated by each actor's onDone ─────────────────────────────────────
  fetchResult: FetchResult | null;
  snapshot: DepSnapshot | null;
  snapshotPath: string | null;
  delta: DepDelta | null;
  // ── failure state ────────────────────────────────────────────────────────
  blockedReason: DepResearchBlockedReason | null;
};

export const initialDepResearchContext = (
  input: DepResearchMachineInput,
): DepResearchMachineContext => ({
  entry: input.entry,
  runId: input.runId,
  fetchedAt: input.fetchedAt,
  scratchDir: input.scratchDir,
  baseDir: input.baseDir,
  fetcher: input.fetcher,
  fetchResult: null,
  snapshot: null,
  snapshotPath: null,
  delta: null,
  blockedReason: null,
});

// ── helpers ────────────────────────────────────────────────────────────────

export function blockedReasonFromError(actor: string, error: unknown): DepResearchBlockedReason {
  const message = error instanceof Error ? error.message : String(error);
  return { actor, message };
}

// ── emitted events ─────────────────────────────────────────────────────────

export type DepResearchEmittedEvent =
  | { type: "DEP_RESEARCH_REQUESTED" }
  | { type: "DEP_FETCH_COMPLETED" }
  | { type: "DEP_SNAPSHOT_WRITTEN" }
  | { type: "DEP_DIFF_COMPUTED" }
  | { type: "DEP_DELTA_CLASSIFIED" }
  | { type: "DEP_RESEARCH_NO_DELTA" };

// ── machine ────────────────────────────────────────────────────────────────

export const depResearchMachine = setup({
  types: {
    context: {} as DepResearchMachineContext,
    input: {} as DepResearchMachineInput,
    emitted: {} as DepResearchEmittedEvent,
  },
  actors: {
    fetchSourceActor,
    buildAndWriteSnapshotActor,
    loadPrevAndDiffActor,
  },
  guards: {
    classificationIsNone: ({ context }) => context.delta?.classification === "none",
  },
}).createMachine({
  id: "dep_research",
  initial: "idle",
  context: ({ input }) => initialDepResearchContext(input),
  states: {
    // Documentary entry state. Emits DEP_RESEARCH_REQUESTED then transitions
    // immediately into `fetching` — no external trigger required.
    idle: {
      entry: emit({ type: "DEP_RESEARCH_REQUESTED" }),
      always: { target: "fetching" },
    },
    fetching: {
      invoke: {
        id: "fetchSource",
        src: "fetchSourceActor",
        input: ({ context }) => ({
          entry: context.entry,
          destDir: context.scratchDir,
          fetcher: context.fetcher,
        }),
        onDone: {
          target: "snapshotting",
          actions: assign({
            fetchResult: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("fetchSource", event.error),
          }),
        },
      },
    },
    snapshotting: {
      entry: emit({ type: "DEP_FETCH_COMPLETED" }),
      invoke: {
        id: "buildAndWriteSnapshot",
        src: "buildAndWriteSnapshotActor",
        input: ({ context }) => ({
          dep: context.entry.name,
          runId: context.runId,
          fetchedAt: context.fetchedAt,
          fetched: context.fetchResult?.paths ?? {},
          failures: context.fetchResult?.failures ?? {},
          baseDir: context.baseDir,
        }),
        onDone: {
          target: "diffing",
          actions: assign({
            snapshot: ({ event }) => event.output.snapshot,
            snapshotPath: ({ event }) => event.output.path,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) =>
              blockedReasonFromError("buildAndWriteSnapshot", event.error),
          }),
        },
      },
    },
    diffing: {
      entry: emit({ type: "DEP_SNAPSHOT_WRITTEN" }),
      invoke: {
        id: "loadPrevAndDiff",
        src: "loadPrevAndDiffActor",
        input: ({ context }) => {
          // Snapshot is non-null on entry to `diffing` — onDone of
          // snapshotting assigned it. The non-null assertion is documented
          // by the state graph; XState does not narrow context across
          // transitions.
          if (!context.snapshot) {
            throw new Error("depResearchMachine: invariant — snapshot is null on entry to diffing");
          }
          return {
            baseDir: context.baseDir,
            dep: context.entry.name,
            currSnapshot: context.snapshot,
            hints: context.entry.classification_hints,
          };
        },
        onDone: {
          target: "classifying",
          actions: assign({
            delta: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("loadPrevAndDiff", event.error),
          }),
        },
      },
    },
    // I-DR1 short-circuit: classification === "none" ⇒ next state is
    // no_delta (filing path unreachable). Eager `always` reads the delta
    // assigned by diffing.onDone.
    classifying: {
      entry: emit({ type: "DEP_DIFF_COMPUTED" }),
      always: [{ target: "no_delta", guard: "classificationIsNone" }, { target: "reporting" }],
    },
    reporting: {
      type: "final",
      // PR-4 (GH-1276) replaces this `final` state with an invoked
      // `fileIssueActor`. The DEP_DELTA_CLASSIFIED emit is the seam the
      // filing actor subscribes to.
      entry: emit({ type: "DEP_DELTA_CLASSIFIED" }),
    },
    no_delta: {
      type: "final",
      entry: emit({ type: "DEP_RESEARCH_NO_DELTA" }),
    },
    failed: {
      type: "final",
    },
  },
});

export type DepResearchMachine = typeof depResearchMachine;
