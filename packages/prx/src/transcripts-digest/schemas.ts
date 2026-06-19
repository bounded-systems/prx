// transcripts-digest boundary schemas (GH-1495).
//
// Zod records for the four data contracts that the per-run digest machine
// crosses: source configuration (which adapter to use), the normalized
// session intermediate every adapter produces, the LLM-extracted candidate
// memory shape, and the per-session digest result. JSON schema artifacts
// at `schemas/transcripts-digest/*.json` are generated from these — the
// directory layer mirrors `src/dep-research/schemas.ts` precedent.
//
// The MemoryCandidate frontmatter shape is load-bearing: it must match the
// `name` / `description` / `metadata.type` / `metadata.originSessionId`
// fields the existing `claude/hooks/inject-memory-shard.sh` SessionStart
// hook already consumes (GH-1460). The commit writer renders this exact
// shape so new shards auto-appear on the next session start.

import { z } from "zod";

export const TranscriptSourceKind = z.enum(["claude-code-jsonl", "claude-web-export"]);
export type TranscriptSourceKind = z.infer<typeof TranscriptSourceKind>;

/**
 * Discriminated input for a source adapter. Each adapter declares its own
 * `kind` literal and the input shape it accepts. v0 ships two adapters; new
 * ones (codex, chatgpt, gemini) slot in by extending this union and the
 * `TranscriptSourceKind` enum.
 */
export const TranscriptSourceConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude-code-jsonl"),
    /**
     * Optional override pointing at an archive directory of `<sessionId>.jsonl`
     * files (same shape as `~/.claude/projects/<encoded>/`). When omitted, the
     * adapter discovers sessions under the live `~/.claude/projects/` tree.
     */
    inputPath: z.string().min(1).optional(),
    /** Optional project-slug filter (matches the encoded path segment). */
    project: z.string().min(1).optional(),
    /** Optional explicit session uuid filter. */
    sessionId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("claude-web-export"),
    /**
     * Path to the directory containing the native web-export pair
     * (`conversations.json` + `memories.json`). The adapter joins the two
     * by conversation id per the GH-1491 2026-05-18 ADR comment.
     */
    inputPath: z.string().min(1),
  }),
]);
export type TranscriptSourceConfig = z.infer<typeof TranscriptSourceConfig>;

export const TranscriptMessageRole = z.enum(["user", "assistant", "tool", "system"]);
export type TranscriptMessageRole = z.infer<typeof TranscriptMessageRole>;

export const TranscriptMessage = z.object({
  role: TranscriptMessageRole,
  /** ISO-8601 timestamp; adapters fall back to the session start when absent. */
  ts: z.string().min(1),
  /**
   * Flattened message text. Adapters serialize multipart Anthropic content
   * arrays (text / tool_use / tool_result) down to a single string so the
   * extractor's prompt stays simple.
   */
  content: z.string(),
  /** Optional Claude Code parent uuid for tree reconstruction. */
  parentUuid: z.string().min(1).optional(),
  /** Optional Claude Code message uuid. */
  uuid: z.string().min(1).optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

/**
 * Normalized intermediate: every source adapter produces this shape. The
 * extractor + writers depend on it; new adapters only need to fit the
 * intermediate to slot in.
 */
export const TranscriptSession = z.object({
  source: TranscriptSourceKind,
  sessionId: z.string().min(1),
  /** Project slug (encoded path segment for `claude-code-jsonl`; "web" otherwise). */
  project: z.string().min(1),
  startTs: z.string().min(1),
  endTs: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  messages: z.array(TranscriptMessage),
  /**
   * Original on-disk reference (path or url) — stamped into `input_refs[]`
   * on every output for I-AUD2 lineage.
   */
  sourceRef: z.string().min(1),
});
export type TranscriptSession = z.infer<typeof TranscriptSession>;

export const MemoryCandidateType = z.enum(["feedback", "project", "reference", "user"]);
export type MemoryCandidateType = z.infer<typeof MemoryCandidateType>;

/**
 * Output shape of the LLM extraction step. Mirrors the YAML frontmatter that
 * `claude/hooks/inject-memory-shard.sh` already consumes (lines 28-34) so
 * committed shards round-trip into SessionStart without conversion.
 *
 * `uowId` + `inputRefs[]` ground I-AUD1/I-AUD2 (audit substrate). They are
 * persisted into the YAML frontmatter of the staged or committed file.
 */
export const MemoryCandidate = z.object({
  type: MemoryCandidateType,
  /** kebab-case slug; becomes the filename stem when staged. */
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case"),
  description: z.string().min(1),
  /** Markdown body — what the user sees inlined into context. */
  body: z.string().min(1),
  /** Source transcript session uuid, used for I-TD5 idempotency. */
  originSessionId: z.string().min(1),
  /** Audit lineage — usually `[<sourceRef>]`. */
  inputRefs: z.array(z.string().min(1)).min(1),
  /** Audit substrate uow_id (I-AUD1). */
  uowId: z.string().min(1),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const DigestResult = z.object({
  session: TranscriptSession,
  candidates: z.array(MemoryCandidate),
  stats: z.object({
    extracted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    dedupCollisions: z.number().int().nonnegative(),
  }),
});
export type DigestResult = z.infer<typeof DigestResult>;
