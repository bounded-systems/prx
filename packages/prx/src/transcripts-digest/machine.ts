// XState v5 per-run machine for `prx transcripts digest` (GH-1495).
//
// Lifecycle: idle → resolving → loading → parsing → extracting →
//   (stage_writing | commit_writing | dry_run_terminal) → completed
//   | no_new_memories | failed_<stage>
//
// Mirrors the dep-research machine shape (`src/dep-research/machine.ts`):
// each invoke wraps a Zod-typed `fromPromise` actor; tests swap actors via
// `transcriptsDigestMachine.provide({ actors })`. TRANSCRIPT_* events emit
// on entry to each downstream state so the audit substrate sees the per-
// run progress without depending on actor result types.

import { assign, emit, setup } from "xstate";

import {
  commitWriteActor,
  extractActor,
  loadActor,
  parseActor,
  resolveSourceActor,
  stageWriteActor,
  type CommitWriteActorResult,
  type ExtractActorResult,
  type LoadActorResult,
  type ParseActorResult,
  type ResolveActorResult,
  type StageWriteActorResult,
} from "./actors.ts";
import type { ClaudePrintRunner } from "./extractor.ts";
import type { MemoryCandidate, TranscriptSession, TranscriptSourceConfig } from "./schemas.ts";

export type TranscriptsDigestMode = "dry-run" | "stage" | "commit";

export type TranscriptsDigestMachineInput = {
  config: TranscriptSourceConfig;
  mode: TranscriptsDigestMode;
  /** Memory directory for stage/commit writers. */
  memoryDir: string;
  uowId: string;
  discover: { since?: string | undefined; limit?: number | undefined };
  /** Injected `claude --print` runner for tests; defaults to the @bounded-systems/proc impl. */
  runner?: ClaudePrintRunner | undefined;
};

export type TranscriptsDigestBlockedReason = {
  actor: string;
  message: string;
};

export type TranscriptsDigestContext = {
  config: TranscriptSourceConfig;
  mode: TranscriptsDigestMode;
  memoryDir: string;
  uowId: string;
  discover: { since?: string | undefined; limit?: number | undefined };
  runner: ClaudePrintRunner | undefined;
  sessions: TranscriptSession[];
  candidates: MemoryCandidate[];
  failedSessionIds: string[];
  stageResult: StageWriteActorResult | null;
  commitResult: CommitWriteActorResult | null;
  blockedReason: TranscriptsDigestBlockedReason | null;
};

const initialContext = (input: TranscriptsDigestMachineInput): TranscriptsDigestContext => ({
  config: input.config,
  mode: input.mode,
  memoryDir: input.memoryDir,
  uowId: input.uowId,
  discover: input.discover,
  runner: input.runner,
  sessions: [],
  candidates: [],
  failedSessionIds: [],
  stageResult: null,
  commitResult: null,
  blockedReason: null,
});

function blockedReasonFromError(actor: string, error: unknown): TranscriptsDigestBlockedReason {
  const message = error instanceof Error ? error.message : String(error);
  return { actor, message };
}

export type TranscriptsDigestEmittedEvent =
  | { type: "TRANSCRIPT_DIGEST_REQUESTED" }
  | { type: "TRANSCRIPT_SOURCE_RESOLVED" }
  | { type: "TRANSCRIPT_LOAD_COMPLETED" }
  | { type: "TRANSCRIPT_PARSE_COMPLETED" }
  | { type: "TRANSCRIPT_PARSE_LINE_SKIPPED" }
  | { type: "TRANSCRIPT_EXTRACTION_COMPLETED" }
  | { type: "TRANSCRIPT_DIGEST_STAGED" }
  | { type: "TRANSCRIPT_DIGEST_COMMITTED" }
  | { type: "TRANSCRIPT_DIGEST_NO_NEW_MEMORIES" }
  | { type: "TRANSCRIPT_DIGEST_FAILED" };

export const transcriptsDigestMachine = setup({
  types: {
    context: {} as TranscriptsDigestContext,
    input: {} as TranscriptsDigestMachineInput,
    emitted: {} as TranscriptsDigestEmittedEvent,
  },
  actors: {
    resolveSourceActor,
    loadActor,
    parseActor,
    extractActor,
    stageWriteActor,
    commitWriteActor,
  },
  guards: {
    isDryRun: ({ context }) => context.mode === "dry-run",
    isStage: ({ context }) => context.mode === "stage",
    isCommit: ({ context }) => context.mode === "commit",
    hasNoCandidates: ({ context }) => context.candidates.length === 0,
  },
}).createMachine({
  id: "transcripts_digest",
  initial: "idle",
  context: ({ input }) => initialContext(input),
  states: {
    idle: {
      entry: emit({ type: "TRANSCRIPT_DIGEST_REQUESTED" }),
      always: { target: "resolving" },
    },
    resolving: {
      invoke: {
        id: "resolveSource",
        src: "resolveSourceActor",
        input: ({ context }) => ({ config: context.config }),
        onDone: { target: "loading" },
        onError: {
          target: "failed_resolve",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("resolveSource", event.error),
          }),
        },
      },
    },
    loading: {
      entry: emit({ type: "TRANSCRIPT_SOURCE_RESOLVED" }),
      invoke: {
        id: "load",
        src: "loadActor",
        input: ({ context }) => ({
          config: context.config,
          discover: context.discover,
        }),
        onDone: {
          target: "parsing",
          actions: assign({
            sessions: ({ event }) => (event.output as LoadActorResult).sessions,
          }),
        },
        onError: {
          target: "failed_load",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("load", event.error),
          }),
        },
      },
    },
    parsing: {
      entry: emit({ type: "TRANSCRIPT_LOAD_COMPLETED" }),
      invoke: {
        id: "parse",
        src: "parseActor",
        input: ({ context }) => ({ sessions: context.sessions }),
        onDone: {
          target: "extracting",
          actions: assign({
            sessions: ({ event }) => (event.output as ParseActorResult).sessions,
          }),
        },
        onError: {
          target: "failed_parse",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("parse", event.error),
          }),
        },
      },
    },
    extracting: {
      entry: emit({ type: "TRANSCRIPT_PARSE_COMPLETED" }),
      invoke: {
        id: "extract",
        src: "extractActor",
        input: ({ context }) => ({
          sessions: context.sessions,
          uowId: context.uowId,
          runner: context.runner,
        }),
        onDone: {
          target: "post_extract",
          actions: assign({
            candidates: ({ event }) => (event.output as ExtractActorResult).candidates,
            failedSessionIds: ({ event }) => (event.output as ExtractActorResult).failedSessions,
          }),
        },
        onError: {
          target: "failed_extract",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("extract", event.error),
          }),
        },
      },
    },
    // Branch on mode + candidate count. I-TD1 (dry-run no writes), I-TD4
    // (no candidates → terminal no-write), I-TD5 (idempotency runs through
    // the writers).
    post_extract: {
      entry: emit({ type: "TRANSCRIPT_EXTRACTION_COMPLETED" }),
      always: [
        { target: "no_new_memories", guard: "hasNoCandidates" },
        { target: "dry_run_terminal", guard: "isDryRun" },
        { target: "stage_writing", guard: "isStage" },
        { target: "commit_writing", guard: "isCommit" },
      ],
    },
    stage_writing: {
      invoke: {
        id: "stageWrite",
        src: "stageWriteActor",
        input: ({ context }) => ({
          candidates: context.candidates,
          memoryDir: context.memoryDir,
        }),
        onDone: {
          target: "staged",
          actions: assign({
            stageResult: ({ event }) => event.output as StageWriteActorResult,
          }),
        },
        onError: {
          target: "failed_write",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("stageWrite", event.error),
          }),
        },
      },
    },
    commit_writing: {
      invoke: {
        id: "commitWrite",
        src: "commitWriteActor",
        input: ({ context }) => ({
          candidates: context.candidates,
          memoryDir: context.memoryDir,
        }),
        onDone: {
          target: "committed",
          actions: assign({
            commitResult: ({ event }) => event.output as CommitWriteActorResult,
          }),
        },
        onError: {
          target: "failed_write",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("commitWrite", event.error),
          }),
        },
      },
    },
    dry_run_terminal: {
      type: "final",
    },
    staged: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_STAGED" }),
    },
    committed: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_COMMITTED" }),
    },
    no_new_memories: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_NO_NEW_MEMORIES" }),
    },
    failed_resolve: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_FAILED" }),
    },
    failed_load: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_FAILED" }),
    },
    failed_parse: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_FAILED" }),
    },
    failed_extract: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_FAILED" }),
    },
    failed_write: {
      type: "final",
      entry: emit({ type: "TRANSCRIPT_DIGEST_FAILED" }),
    },
  },
});

export type TranscriptsDigestMachine = typeof transcriptsDigestMachine;
// Re-export for test convenience.
export type { ResolveActorResult };
