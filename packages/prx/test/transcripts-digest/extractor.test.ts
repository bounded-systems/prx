import { describe, expect, test } from "bun:test";

import { extractMemoryCandidates } from "../../src/transcripts-digest/extractor.ts";
import type { TranscriptSession } from "../../src/transcripts-digest/schemas.ts";

const baseSession: TranscriptSession = {
  source: "claude-code-jsonl",
  sessionId: "sess-x",
  project: "p",
  startTs: "2026-05-01T00:00:00.000Z",
  endTs: "2026-05-01T00:01:00.000Z",
  messageCount: 1,
  messages: [
    {
      role: "user",
      ts: "2026-05-01T00:00:00.000Z",
      content: "remember: I prefer terse responses",
    },
  ],
  sourceRef: "/tmp/sess-x.jsonl",
};

function envelopeReturning(text: string, exitCode = 0) {
  const envelope = JSON.stringify([
    { type: "system" },
    { type: "result", subtype: "success", is_error: false, result: text },
  ]);
  return async () => ({ exitCode, stdout: envelope, stderr: "" });
}

describe("extractMemoryCandidates", () => {
  test("parses a valid candidate JSON array", async () => {
    const runner = envelopeReturning(
      JSON.stringify([
        {
          type: "feedback",
          name: "prefer-terse-responses",
          description: "user wants terse replies",
          body: "Keep responses tight. **Why:** stated preference. **How to apply:** no preamble.",
        },
      ]),
    );

    const result = await extractMemoryCandidates(baseSession, {
      uowId: "uow-1",
      runner,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.type).toBe("feedback");
    expect(result.candidates[0]!.originSessionId).toBe("sess-x");
    expect(result.candidates[0]!.inputRefs).toEqual(["/tmp/sess-x.jsonl"]);
    expect(result.candidates[0]!.uowId).toBe("uow-1");
  });

  test("returns ok with empty array when extractor finds nothing", async () => {
    const runner = envelopeReturning("[]");
    const result = await extractMemoryCandidates(baseSession, {
      uowId: "uow-2",
      runner,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
  });

  test("strips json code fence around the array", async () => {
    const runner = envelopeReturning("```json\n[]\n```");
    const result = await extractMemoryCandidates(baseSession, {
      uowId: "uow-3",
      runner,
    });
    expect(result.ok).toBe(true);
  });

  test("fails when the runner exits non-zero", async () => {
    const runner = async () => ({ exitCode: 2, stdout: "", stderr: "boom" });
    const result = await extractMemoryCandidates(baseSession, {
      uowId: "uow-4",
      runner,
    });
    expect(result.ok).toBe(false);
  });

  test("filters out candidates that fail Zod validation", async () => {
    const runner = envelopeReturning(
      JSON.stringify([
        { type: "feedback", name: "Bad Name", description: "x", body: "y" },
        {
          type: "project",
          name: "good-name",
          description: "x",
          body: "y",
        },
      ]),
    );
    const result = await extractMemoryCandidates(baseSession, {
      uowId: "uow-5",
      runner,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "Bad Name" violates the kebab-case regex; only `good-name` survives.
    expect(result.candidates.map((c) => c.name)).toEqual(["good-name"]);
  });
});
