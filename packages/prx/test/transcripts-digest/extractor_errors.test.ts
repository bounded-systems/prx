// transcripts-digest/extractor — the boundary-failure arms of
// extractMemoryCandidates. Driven through the injected `runner` seam (no real
// `claude --print`): spawn throw, non-zero exit, an un-parseable envelope, a
// non-JSON assistant payload, and a payload that isn't a JSON array.

import { describe, expect, test } from "bun:test";

import { extractMemoryCandidates } from "../../src/transcripts-digest/extractor.ts";
import type { TranscriptSession } from "../../src/transcripts-digest/schemas.ts";
import type { ClaudePrintRunner } from "../../src/transcripts-digest/extractor.ts";

const session: TranscriptSession = {
  source: "claude-code-jsonl",
  sessionId: "sess-x",
  project: "p",
  startTs: "2026-05-01T00:00:00.000Z",
  endTs: "2026-05-01T00:01:00.000Z",
  messageCount: 1,
  messages: [{ role: "user", ts: "2026-05-01T00:00:00.000Z", content: "remember: terse" }],
  sourceRef: "/tmp/sess-x.jsonl",
};

// Wrap an assistant `result` text in the `claude --print --output-format json`
// envelope the extractor parses.
const envelope = (text: string, exitCode = 0): ClaudePrintRunner => async () => ({
  exitCode,
  stdout: JSON.stringify([
    { type: "system" },
    { type: "result", subtype: "success", is_error: false, result: text },
  ]),
  stderr: "",
});

const run = (runner: ClaudePrintRunner) => extractMemoryCandidates(session, { uowId: "uow-1", runner });

describe("extractMemoryCandidates — failure modes", () => {
  test("a spawn throw is captured as ok:false", async () => {
    const r = await run(async () => {
      throw new Error("agent down");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("spawn failed");
  });

  test("a non-zero exit is captured with the exit code", async () => {
    const r = await run(async () => ({ exitCode: 2, stdout: "", stderr: "boom-stderr" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("exit 2");
  });

  test("an un-parseable envelope is captured", async () => {
    const r = await run(async () => ({ exitCode: 0, stdout: "not a claude envelope", stderr: "" }));
    expect(r.ok).toBe(false);
  });

  test("a non-JSON assistant payload is captured", async () => {
    const r = await run(envelope("this is not json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not JSON/i);
  });

  test("an assistant payload that isn't a JSON array is captured", async () => {
    const r = await run(envelope(JSON.stringify({ not: "an array" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/array/i);
  });

  test("entries with an invalid candidate type are skipped, not fatal", async () => {
    const r = await run(
      envelope(JSON.stringify([{ type: "not-a-real-type", name: "x" }, { noteven: true }])),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates).toEqual([]);
  });
});
