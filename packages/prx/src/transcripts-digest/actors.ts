// XState `fromPromise` actors for the per-run transcripts-digest machine
// (GH-1495).
//
// Mirrors the dep-research actor shape (`src/dep-research/actors.ts`): each
// actor wraps a Zod-validated input and delegates to the real per-stage
// primitive (adapter discovery, parser, extractor, stage/commit writers).
// Tests swap actors via `transcriptsDigestMachine.provide({ actors })`
// rather than mocking module internals.

import { fromPromise } from "xstate";
import { z } from "zod";

import { commitCandidate } from "./commit-writer.ts";
import { extractMemoryCandidates, type ClaudePrintRunner } from "./extractor.ts";
import { MemoryCandidate, TranscriptSession, TranscriptSourceConfig } from "./schemas.ts";
import type { MemoryCandidate as MemoryCandidateT } from "./schemas.ts";
import { getAdapter, type DiscoverOptions } from "./sources/registry.ts";
import { writeStagedCandidate } from "./stage-writer.ts";

// ── resolve actor ──────────────────────────────────────────────────────────

const resolveInputSchema = z.object({
  config: TranscriptSourceConfig,
});
export type ResolveActorInput = z.infer<typeof resolveInputSchema>;
export type ResolveActorResult = {
  adapter: ReturnType<typeof getAdapter>;
};

export const resolveSourceActor = fromPromise<ResolveActorResult, ResolveActorInput>(
  async ({ input }) => {
    const opts = resolveInputSchema.parse(input);
    return { adapter: getAdapter(opts.config.kind) };
  },
);

// ── load actor (discover sessions) ─────────────────────────────────────────

const loadInputSchema = z.object({
  config: TranscriptSourceConfig,
  discover: z.object({
    since: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
});
export type LoadActorInput = z.infer<typeof loadInputSchema>;
export type LoadActorResult = { sessions: TranscriptSession[] };

export const loadActor = fromPromise<LoadActorResult, LoadActorInput>(async ({ input }) => {
  const opts = loadInputSchema.parse(input);
  const adapter = getAdapter(opts.config.kind);
  const sessions: TranscriptSession[] = [];
  for await (const session of adapter.discover(opts.config, opts.discover as DiscoverOptions)) {
    sessions.push(TranscriptSession.parse(session));
  }
  return { sessions };
});

// ── parse actor ────────────────────────────────────────────────────────────
//
// In this v0 the adapters are also the parsers — the load actor already
// produced normalized TranscriptSessions. parseActor stays in the surface
// for the machine event sequence (TRANSCRIPT_PARSE_COMPLETED is the seam
// future adapters can swap in batched parsing on), but for v0 it's a pure
// pass-through.

const parseInputSchema = z.object({
  sessions: z.array(TranscriptSession),
});
export type ParseActorInput = z.infer<typeof parseInputSchema>;
export type ParseActorResult = {
  sessions: TranscriptSession[];
  skippedLines: number;
};

export const parseActor = fromPromise<ParseActorResult, ParseActorInput>(async ({ input }) => {
  const opts = parseInputSchema.parse(input);
  return { sessions: opts.sessions, skippedLines: 0 };
});

// ── extract actor ──────────────────────────────────────────────────────────

const extractInputSchema = z.object({
  sessions: z.array(TranscriptSession),
  uowId: z.string().min(1),
});
export type ExtractActorInput = z.infer<typeof extractInputSchema> & {
  runner?: ClaudePrintRunner | undefined;
};
export type ExtractActorResult = {
  candidates: MemoryCandidateT[];
  failedSessions: string[];
};

export const extractActor = fromPromise<ExtractActorResult, ExtractActorInput>(
  async ({ input }) => {
    const opts = extractInputSchema.parse({
      sessions: input.sessions,
      uowId: input.uowId,
    });
    const collected: MemoryCandidateT[] = [];
    const failed: string[] = [];
    for (const session of opts.sessions) {
      const result = await extractMemoryCandidates(session, {
        uowId: opts.uowId,
        runner: input.runner,
      });
      if (!result.ok) {
        failed.push(session.sessionId);
        continue;
      }
      for (const c of result.candidates) {
        collected.push(MemoryCandidate.parse(c));
      }
    }
    return { candidates: collected, failedSessions: failed };
  },
);

// ── write actors (stage | commit) ──────────────────────────────────────────

const stageWriteInputSchema = z.object({
  candidates: z.array(MemoryCandidate),
  memoryDir: z.string().min(1),
});
export type StageWriteActorInput = z.infer<typeof stageWriteInputSchema>;
export type StageWriteActorResult = {
  written: number;
  skipped: number;
  paths: string[];
};

export const stageWriteActor = fromPromise<StageWriteActorResult, StageWriteActorInput>(
  async ({ input }) => {
    const opts = stageWriteInputSchema.parse(input);
    let written = 0;
    let skipped = 0;
    const paths: string[] = [];
    for (const candidate of opts.candidates) {
      const r = writeStagedCandidate(candidate, opts.memoryDir);
      paths.push(r.path);
      if (r.skipped) skipped += 1;
      else written += 1;
    }
    return { written, skipped, paths };
  },
);

const commitWriteInputSchema = z.object({
  candidates: z.array(MemoryCandidate),
  memoryDir: z.string().min(1),
});
export type CommitWriteActorInput = z.infer<typeof commitWriteInputSchema>;
export type CommitWriteActorResult = {
  committed: number;
  skippedDuplicate: number;
  refusedCap: number;
  paths: string[];
};

export const commitWriteActor = fromPromise<CommitWriteActorResult, CommitWriteActorInput>(
  async ({ input }) => {
    const opts = commitWriteInputSchema.parse(input);
    let committed = 0;
    let skippedDuplicate = 0;
    let refusedCap = 0;
    const paths: string[] = [];
    for (const candidate of opts.candidates) {
      const r = commitCandidate(candidate, opts.memoryDir);
      if (r.status === "committed") {
        committed += 1;
        if (r.candidatePath) paths.push(r.candidatePath);
      } else if (r.status === "skipped-duplicate") {
        skippedDuplicate += 1;
      } else {
        refusedCap += 1;
      }
    }
    return { committed, skippedDuplicate, refusedCap, paths };
  },
);
