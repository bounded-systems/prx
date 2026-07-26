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

// GH-1012: `triage promote` (bd→GH mirror publish) and `triage drift-fix`
// (bd↔GH reconcile) are retired — GitHub is the write plane and the bd
// substrate is gone, so their verb modules were deleted. The triage machine
// still invokes no-op actors at the `promoting` / `driftFixing` stages so its
// lifecycle flow is preserved. These minimal result shapes stand in for the
// deleted verb result types; they are only stored in machine context (no source
// consumer reads them).
export type TriagePromoteActorResult = {
  exitCode: number;
  promotedBeadIds: string[];
  stdout: string[];
  stderr: string[];
};
export type TriageDriftFixActorResult = {
  exitCode: number;
  writes: number;
  skips: number;
  errors: number;
  touchedIssues: number[];
  stdout: string[];
  stderr: string[];
};

// ── actor input types (options + an injectable, test-only deps seam) ────────

export type StatusActorInput = TriageStatusOptions & { deps?: TriageStatusDeps };
export type ClassifyActorInput = TriageClassifyOptions & { deps?: TriageClassifyDeps };
export type ApplyActorInput = TriageApplyOptions & { deps?: TriageApplyDeps };
export type PrioritizeActorInput = TriagePrioritizeOptions & { deps?: TriagePrioritizeDeps };
// GH-1012: local option shapes for the retired promote/drift-fix verbs (their
// schema modules were deleted). Mirror exactly the input the triage machine's
// `promoting` / `driftFixing` states construct.
type TriagePromoteOptions = {
  repo?: string | undefined;
  dryRun: boolean;
  limit: number;
};
type TriageDriftFixOptions = {
  repo?: string | undefined;
  axes: readonly ("type" | "priority" | "status")[];
  limit: number;
  dryRun: boolean;
  apply: boolean;
  sync: boolean;
  includeDupes: boolean;
  includeDoctor: boolean;
  applyDupes: boolean;
  doctorFix: boolean;
};

export type PromoteActorInput = TriagePromoteOptions & { deps?: unknown };
export type TypePassActorInput = TriageTypePassOptions & { deps?: TriageTypePassDeps };
export type PrioritizeBulkActorInput = TriagePrioritizeBulkOptions & {
  deps?: TriagePrioritizeBulkDeps;
};
export type PruneMergedActorInput = TriagePruneMergedOptions & { deps?: TriagePruneMergedDeps };
export type DriftFixActorInput = TriageDriftFixOptions & { deps?: unknown };

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

export const promoteActor = fromPromise<TriagePromoteActorResult, PromoteActorInput>(async () => {
  // GH-1012: no-op — promotion (bd→GH mirror publish) is retired.
  return { exitCode: 0, promotedBeadIds: [], stdout: [], stderr: [] };
});

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

// GH-1342 — driftFixActor wired to the real verb so `prx triage prime
// --auto-drift-fix` can chain reconcile into each iteration. The GH-1049
// stub (`throw new TriageStubError("drift-fix", "GH-1049")`) was removed
// here; `runDriftFixActor` forces `apply: true` so the machine's
// `driftFixing` state always runs the one-shot apply path.
export const driftFixActor = fromPromise<TriageDriftFixActorResult, DriftFixActorInput>(
  async () => {
    // GH-1012: no-op — drift-fix reconcile is retired.
    return {
      exitCode: 0,
      writes: 0,
      skips: 0,
      errors: 0,
      touchedIssues: [],
      stdout: [],
      stderr: [],
    };
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
