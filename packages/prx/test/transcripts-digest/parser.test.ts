import { describe, expect, test } from "bun:test";

import { parseClaudeJsonl } from "../../src/transcripts-digest/parser.ts";

describe("parseClaudeJsonl", () => {
  test("normalizes user + assistant messages with timestamps", () => {
    const body = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-01T00:00:00.000Z",
        uuid: "u-1",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        timestamp: "2026-05-01T00:00:01.000Z",
        uuid: "a-1",
        parentUuid: "u-1",
      }),
    ].join("\n");

    const result = parseClaudeJsonl(body);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages[0]!.content).toBe("hello");
    expect(result.messages[1]!.content).toBe("hi");
    expect(result.messages[1]!.parentUuid).toBe("u-1");
    expect(result.startTs).toBe("2026-05-01T00:00:00.000Z");
    expect(result.endTs).toBe("2026-05-01T00:00:01.000Z");
    expect(result.skipped).toBe(0);
  });

  test("I-TD6: malformed JSON lines are counted as skipped, not fatal", () => {
    const body = [
      "{not json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
      "{",
    ].join("\n");

    const result = parseClaudeJsonl(body);
    expect(result.messages.length).toBe(1);
    expect(result.skipped).toBe(2);
  });

  test("snapshot rows are silently dropped, not counted as skipped", () => {
    const body = [
      JSON.stringify({ type: "file-history-snapshot", messageId: "x" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
    ].join("\n");
    const result = parseClaudeJsonl(body);
    expect(result.messages.length).toBe(1);
    expect(result.skipped).toBe(0);
  });

  test("flattens tool_use content into a single-line string", () => {
    const body = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "calling bash" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    const result = parseClaudeJsonl(body);
    expect(result.messages[0]!.content).toContain("calling bash");
    expect(result.messages[0]!.content).toContain("[tool_use Bash");
  });
});
