// XState `fromPromise` actors that wrap each triage verb. Real actors
// (status, classify, apply, prioritize, promote, …) delegate to the
// `run<Verb>Actor` extractions in their respective verb files. The report
// actor is a stub that rejects immediately with a "not implemented — see
// GH-XXXX" error so the machine's `onError` transition lands the run in
// `blocked` with the blocking ticket recorded in context.
//
// Each actor accepts a Zod-validated input matching its options schema and
// returns the verb's actor-shaped result type. The machine wires actor
// outputs into context via `assign()` in the relevant `onDone` handler.
//
// Testability (mirrors `dep-research/actors`): every real actor's input carries
// an optional `deps` seam that is forwarded to the delegate. The machine never
// supplies it (production uses the real deps), but a test can inject fakes so
// the wrapper — and the delegate's heavy gh/bd IO — stays hermetic. The seam is
// read off `input` directly; only the option fields are Zod-validated.

import { fromPromise } from "xstate";

import { runStatusActor, type TriageStatusActorResult, type TriageStatusDeps } from "./triage.ts";
import {
  runClassifyActor,
  type TriageClassifyActorResult,
  type TriageClassifyDeps,
} from "./classifier.ts";
import { runApplyActor, type TriageApplyActorResult, type TriageApplyDeps } from "./apply.ts";
import {
  runPrioritizeActor,
  type TriagePrioritizeActorResult,
  type TriagePrioritizeDeps,
} from "./prioritize.ts";
import {
  runTypePassActor,
  type TriageTypePassActorResult,
  type TriageTypePassDeps,
} from "./type-pass.ts";
import {
  runPrioritizeBulkActor,
  type TriagePrioritizeBulkActorResult,
  type TriagePrioritizeBulkDeps,
} from "./prioritize-bulk.ts";
import {
  runPruneMergedActor,
  type TriagePruneMergedActorResult,
  type TriagePruneMergedDeps,
} from "./prune-merged.ts";

import {
  triageStatusOptionsSchema,
  triageClassifyOptionsSchema,
  triageApplyOptionsSchema,
  triagePrioritizeOptionsSchema,
  triageTypePassOptionsSchema,
  triagePrioritizeBulkOptionsSchema,
  triageReportOptionsSchema,
  triagePruneMergedOptionsSchema,
  type TriageStatusOptions,
  type TriageClassifyOptions,
  type TriageApplyOptions,
  type TriagePrioritizeOptions,
  type TriageTypePassOptions,
  type TriagePrioritizeBulkOptions,
  type TriageReportOptions,
  type TriagePruneMergedOptions,
} from "./schemas/index.ts";

// GH-1023: `triage promote` (bd→GH mirror publish) and `triage drift-fix`
// (bd↔GH reconcile) are retired — GitHub is the write plane and the bd
// substrate is gone. Their verb modules were deleted (GH-1012) and the no-op
// actor stubs that preserved the machine's `promoting` / `driftFixing` stages
// are now removed too, along with the machine states that invoked them.

// ── actor input types (options + an injectable, test-only deps seam) ────────

export type StatusActorInput = TriageStatusOptions & { deps?: TriageStatusDeps };
export type ClassifyActorInput = TriageClassifyOptions & { deps?: TriageClassifyDeps };
export type ApplyActorInput = TriageApplyOptions & { deps?: TriageApplyDeps };
export type PrioritizeActorInput = TriagePrioritizeOptions & { deps?: TriagePrioritizeDeps };
export type TypePassActorInput = TriageTypePassOptions & { deps?: TriageTypePassDeps };
export type PrioritizeBulkActorInput = TriagePrioritizeBulkOptions & {
  deps?: TriagePrioritizeBulkDeps;
};
export type PruneMergedActorInput = TriagePruneMergedOptions & { deps?: TriagePruneMergedDeps };

// ── real actors ────────────────────────────────────────────────────────────

export const statusActor = fromPromise<TriageStatusActorResult, StatusActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triageStatusOptionsSchema.parse(data);
    return runStatusActor(opts, deps);
  },
);

export const classifyActor = fromPromise<TriageClassifyActorResult, ClassifyActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triageClassifyOptionsSchema.parse(data);
    return runClassifyActor(opts, deps);
  },
);

export const applyActor = fromPromise<TriageApplyActorResult, ApplyActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triageApplyOptionsSchema.parse(data);
    return runApplyActor(opts, deps);
  },
);

export const prioritizeActor = fromPromise<TriagePrioritizeActorResult, PrioritizeActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triagePrioritizeOptionsSchema.parse(data);
    return runPrioritizeActor(opts, deps);
  },
);

// GH-1125 — `prx prune --merged-only` pre-step at the head of the triage
// machine. Closes GH issues whose linked PR is already merged so the
// status snapshot the rest of the machine reads is free of merged-PR
// drift on its first iteration.
export const pruneMergedActor = fromPromise<TriagePruneMergedActorResult, PruneMergedActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triagePruneMergedOptionsSchema.parse(data);
    return await runPruneMergedActor(opts, deps);
  },
);

export const prioritizeBulkActor = fromPromise<
  TriagePrioritizeBulkActorResult,
  PrioritizeBulkActorInput
>(async ({ input }) => {
  const { deps, ...data } = input;
  const opts = triagePrioritizeBulkOptionsSchema.parse(data);
  return runPrioritizeBulkActor(opts, deps);
});

// GH-1021 — typePassActor is now wired to the real verb. The stub `throw new
// TriageStubError("type-pass", "GH-1021")` was removed when the verb landed.
export const typePassActor = fromPromise<TriageTypePassActorResult, TypePassActorInput>(
  async ({ input }) => {
    const { deps, ...data } = input;
    const opts = triageTypePassOptionsSchema.parse(data);
    return runTypePassActor(opts, deps);
  },
);

// ── stub actor ───────────────────────────────────────────────────────────────
//
// `report` rejects immediately. The machine's `onError` transitions to
// `blocked` and records the ticket reference in context. The stub validates its
// input first so a typed-input regression in a sibling PR fails loudly.

export class TriageStubError extends Error {
  readonly ticket: string;
  readonly verb: string;
  constructor(verb: string, ticket: string) {
    super(`triage ${verb}: not implemented — see ${ticket}`);
    this.name = "TriageStubError";
    this.ticket = ticket;
    this.verb = verb;
  }
}

export const reportActor = fromPromise<never, TriageReportOptions>(async ({ input }) => {
  triageReportOptionsSchema.parse(input);
  throw new TriageStubError("report", "GH-1022");
});
