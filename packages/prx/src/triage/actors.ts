// XState `fromPromise` actors that wrap each triage verb. Real actors
// (status, classify, apply, prioritize, promote) delegate to the
// `runAs<Verb>Actor` extractions in their respective verb files. Stub
// actors (drift-fix, report) reject immediately with a "not implemented
// — see GH-XXXX" error so the machine's `onError` transition lands the
// run in `blocked` with the blocking ticket recorded in context.
//
// Each actor accepts a Zod-validated input matching its options schema and
// returns the verb's actor-shaped result type. The machine wires actor
// outputs into context via `assign()` in the relevant `onDone` handler.

import { fromPromise } from "xstate";

import {
  runStatusActor,
  type TriageStatusActorResult,
} from "./triage.ts";
import {
  runClassifyActor,
  type TriageClassifyActorResult,
} from "./classifier.ts";
import {
  runApplyActor,
  type TriageApplyActorResult,
} from "./apply.ts";
import {
  runPrioritizeActor,
  type TriagePrioritizeActorResult,
} from "./prioritize.ts";
import {
  runPromoteActor,
  type TriagePromoteActorResult,
} from "./promote.ts";
import {
  runTypePassActor,
  type TriageTypePassActorResult,
} from "./type-pass.ts";
import {
  runPrioritizeBulkActor,
  type TriagePrioritizeBulkActorResult,
} from "./prioritize-bulk.ts";
import {
  runPruneMergedActor,
  type TriagePruneMergedActorResult,
} from "./prune-merged.ts";
import {
  runDriftFixActor,
  type TriageDriftFixActorResult,
} from "./drift-fix.ts";

import {
  triageStatusOptionsSchema,
  triageClassifyOptionsSchema,
  triageApplyOptionsSchema,
  triagePrioritizeOptionsSchema,
  triagePromoteOptionsSchema,
  triageTypePassOptionsSchema,
  triagePrioritizeBulkOptionsSchema,
  triageDriftFixOptionsSchema,
  triageReportOptionsSchema,
  triagePruneMergedOptionsSchema,
  type TriageStatusOptions,
  type TriageClassifyOptions,
  type TriageApplyOptions,
  type TriagePrioritizeOptions,
  type TriagePromoteOptions,
  type TriageTypePassOptions,
  type TriagePrioritizeBulkOptions,
  type TriageDriftFixOptions,
  type TriageReportOptions,
  type TriagePruneMergedOptions,
} from "./schemas/index.ts";

// ── real actors ────────────────────────────────────────────────────────────

export const statusActor = fromPromise<TriageStatusActorResult, TriageStatusOptions>(
  async ({ input }) => {
    const opts = triageStatusOptionsSchema.parse(input);
    return runStatusActor(opts);
  },
);

export const classifyActor = fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(
  async ({ input }) => {
    const opts = triageClassifyOptionsSchema.parse(input);
    return runClassifyActor(opts);
  },
);

export const applyActor = fromPromise<TriageApplyActorResult, TriageApplyOptions>(
  async ({ input }) => {
    const opts = triageApplyOptionsSchema.parse(input);
    return runApplyActor(opts);
  },
);

export const prioritizeActor = fromPromise<
  TriagePrioritizeActorResult,
  TriagePrioritizeOptions
>(async ({ input }) => {
  const opts = triagePrioritizeOptionsSchema.parse(input);
  return runPrioritizeActor(opts);
});

export const promoteActor = fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(
  async ({ input }) => {
    const opts = triagePromoteOptionsSchema.parse(input);
    return runPromoteActor(opts);
  },
);

// GH-1125 — `prx prune --merged-only` pre-step at the head of the triage
// machine. Closes GH issues whose linked PR is already merged so the
// status snapshot the rest of the machine reads is free of merged-PR
// drift on its first iteration.
export const pruneMergedActor = fromPromise<
  TriagePruneMergedActorResult,
  TriagePruneMergedOptions
>(async ({ input }) => {
  const opts = triagePruneMergedOptionsSchema.parse(input);
  return await runPruneMergedActor(opts);
});

export const prioritizeBulkActor = fromPromise<
  TriagePrioritizeBulkActorResult,
  TriagePrioritizeBulkOptions
>(async ({ input }) => {
  const opts = triagePrioritizeBulkOptionsSchema.parse(input);
  return runPrioritizeBulkActor(opts);
});

// ── stub actors ────────────────────────────────────────────────────────────
//
// These reject immediately. The machine's `onError` for each invoke transitions
// to `blocked` and records the ticket reference in context. Stubs validate
// their input first so a typed-input regression in a sibling PR fails loudly.

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

// GH-1021 — typePassActor is now wired to the real verb. The stub `throw new
// TriageStubError("type-pass", "GH-1021")` was removed when the verb landed.
export const typePassActor = fromPromise<TriageTypePassActorResult, TriageTypePassOptions>(
  async ({ input }) => {
    const opts = triageTypePassOptionsSchema.parse(input);
    return runTypePassActor(opts);
  },
);

// GH-1342 — driftFixActor wired to the real verb so `prx triage prime
// --auto-drift-fix` can chain reconcile into each iteration. The GH-1049
// stub (`throw new TriageStubError("drift-fix", "GH-1049")`) was removed
// here; `runDriftFixActor` forces `apply: true` so the machine's
// `driftFixing` state always runs the one-shot apply path.
export const driftFixActor = fromPromise<
  TriageDriftFixActorResult,
  TriageDriftFixOptions
>(async ({ input }) => {
  const opts = triageDriftFixOptionsSchema.parse(input);
  return await runDriftFixActor(opts);
});

export const reportActor = fromPromise<never, TriageReportOptions>(async ({ input }) => {
  triageReportOptionsSchema.parse(input);
  throw new TriageStubError("report", "GH-1022");
});
