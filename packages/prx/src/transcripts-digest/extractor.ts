// LLM-driven memory-candidate extraction for `prx transcripts digest`
// (GH-1495).
//
// Shells out to the local `claude --print --output-format json` binary with a
// versioned, deterministic prompt (`DIGEST_PROMPT_V1`). The boundary codec is
// `parseClaudeJsonEnvelope` (GH-1095). The assistant must reply with a JSON
// array of `MemoryCandidate` objects, which is then validated against the Zod
// schema in `./schemas.ts`. Anything that fails validation surfaces as a
// failed-extract for that session — see I-TD6 (partial-tolerant).
//
// The runner is injectable so tests do not need the real `claude` binary.

import { localProcExecutor } from "@bounded-systems/proc";

import { parseClaudeJsonEnvelope } from "../claude/envelope.ts";
import { stripCodeFence } from "../claude/strip-code-fence.ts";
import {
  MemoryCandidate,
  type MemoryCandidate as MemoryCandidateT,
  MemoryCandidateType,
  type TranscriptSession,
} from "./schemas.ts";

/**
 * Versioned prompt. Frozen as a constant so prompt revisions show up as
 * diff-reviewable edits and old runs stay reproducible. The prompt instructs
 * the model to emit a JSON array of MemoryCandidate objects — the same shape
 * `claude/hooks/inject-memory-shard.sh` already loads from the on-disk YAML
 * frontmatter, so committed shards round-trip with no conversion.
 */
export const DIGEST_PROMPT_V1 = `You are extracting durable memories from a Claude Code transcript.

Memories must compress lasting knowledge — preferences, project state, external
references, or who-the-user-is — that should survive after this transcript
ages out. Do NOT extract ephemeral facts (in-progress work, debugging steps,
one-off commands).

Memory types and when to use them:
- feedback: guidance the user gave on HOW to work (rules, corrections, validated approaches)
- project:  ongoing initiatives, decisions, deadlines, stakeholder context
- reference: pointers to external systems (Linear projects, dashboards, channels)
- user:     who the user is — role, expertise, responsibilities

Output ONLY a JSON array of objects. Each object must have:
{
  "type":        "feedback" | "project" | "reference" | "user",
  "name":        kebab-case slug (a-z, 0-9, hyphens),
  "description": one-line summary used for future recall ranking,
  "body":        markdown body, with **Why:** and **How to apply:** sections for feedback/project memories
}

If nothing in the transcript meets the durability bar, output [].

Transcript follows.`;

export type ClaudePrintRunner = (input: {
  prompt: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const proc = localProcExecutor();

export const defaultClaudePrintRunner: ClaudePrintRunner = async ({
  prompt,
}) => {
  const result = await proc.exec({
    command: "claude",
    args: ["--print", "--output-format", "json"],
    stdin: prompt,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

function renderSessionForPrompt(session: TranscriptSession): string {
  const header = [
    `# Session ${session.sessionId}`,
    `source: ${session.source}`,
    `project: ${session.project}`,
    `messages: ${session.messageCount}`,
    "",
  ].join("\n");
  const body = session.messages
    .map((m) => `## ${m.role}\n${m.content}`)
    .join("\n\n");
  return `${header}\n${body}`;
}

export type ExtractMemoryCandidatesOptions = {
  /** Stamped onto every candidate's `uowId` for I-AUD1 lineage. */
  uowId: string;
  /** Replaceable runner for tests (default: the @bounded-systems/proc `claude --print` runner). */
  runner?: ClaudePrintRunner | undefined;
};

export type ExtractMemoryCandidatesResult =
  | { ok: true; candidates: MemoryCandidateT[] }
  | { ok: false; error: string };

/**
 * Run extraction for one session. Returns `{ok: true, candidates}` on success
 * (possibly empty), `{ok: false, error}` on any boundary failure. The machine
 * uses an empty `candidates` array to fire TRANSCRIPT_DIGEST_NO_NEW_MEMORIES
 * (I-TD4).
 */
export async function extractMemoryCandidates(
  session: TranscriptSession,
  opts: ExtractMemoryCandidatesOptions,
): Promise<ExtractMemoryCandidatesResult> {
  const runner = opts.runner ?? defaultClaudePrintRunner;
  const prompt = `${DIGEST_PROMPT_V1}\n\n${renderSessionForPrompt(session)}`;

  let runResult: { exitCode: number; stdout: string; stderr: string };
  try {
    runResult = await runner({ prompt });
  } catch (err) {
    return { ok: false, error: `claude --print spawn failed: ${(err as Error).message}` };
  }
  if (runResult.exitCode !== 0) {
    return {
      ok: false,
      error: `claude --print exit ${runResult.exitCode}: ${runResult.stderr.slice(0, 300)}`,
    };
  }

  let envelopeText: string;
  try {
    envelopeText = parseClaudeJsonEnvelope(runResult.stdout).result;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const stripped = stripCodeFence(envelopeText.trim());
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error: `extractor: assistant payload was not JSON (${(err as Error).message}); first 200 bytes: ${stripped.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `extractor: assistant payload was not a JSON array (got ${typeof raw})`,
    };
  }

  const candidates: MemoryCandidateT[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const typeParsed = MemoryCandidateType.safeParse(obj.type);
    if (!typeParsed.success) continue;
    const candidateInput = {
      type: typeParsed.data,
      name: obj.name,
      description: obj.description,
      body: obj.body,
      originSessionId: session.sessionId,
      inputRefs: [session.sourceRef],
      uowId: opts.uowId,
    };
    const parsed = MemoryCandidate.safeParse(candidateInput);
    if (!parsed.success) continue;
    candidates.push(parsed.data);
  }

  return { ok: true, candidates };
}
