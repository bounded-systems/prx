// transcripts-digest/parser — the content-flattening arms (tool_use,
// tool_result string + array) and the skip arms (malformed JSON, non-object,
// snapshot rows, role-from-message). The base user/assistant paths live in
// parser.test.ts.

import { describe, expect, test } from "bun:test";

import { parseClaudeJsonl } from "../../src/transcripts-digest/parser.ts";

const row = (o: object) => JSON.stringify(o);

describe("parseClaudeJsonl — content flattening", () => {
  test("flattens a tool_use block", () => {
    const body = row({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { path: "x" } }],
      },
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    const r = parseClaudeJsonl(body);
    expect(r.messages[0]!.content).toContain("[tool_use Read");
    expect(r.messages[0]!.content).toContain('"path":"x"');
  });

  test("flattens a string tool_result", () => {
    const body = row({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "the output" }] },
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    expect(parseClaudeJsonl(body).messages[0]!.content).toContain("[tool_result: the output]");
  });

  test("flattens an array tool_result", () => {
    const body = row({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: [{ type: "text", text: "nested" }] }],
      },
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    expect(parseClaudeJsonl(body).messages[0]!.content).toContain("nested");
  });
});

describe("parseClaudeJsonl — skip arms", () => {
  test("counts malformed JSON and non-object rows as skipped", () => {
    const body = ["{ not json", "42", '"a string"'].join("\n");
    const r = parseClaudeJsonl(body);
    expect(r.messages).toHaveLength(0);
    expect(r.skipped).toBe(3);
  });

  test("silently skips a file-history-snapshot row (not counted as skipped)", () => {
    const body = [
      row({ type: "file-history-snapshot" }),
      row({
        type: "user",
        message: { role: "user", content: "hi" },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
    ].join("\n");
    const r = parseClaudeJsonl(body);
    expect(r.messages).toHaveLength(1);
    expect(r.skipped).toBe(0);
  });

  test("derives the role from message.role when type isn't a role", () => {
    const body = row({
      type: "result",
      message: { role: "assistant", content: "from message.role" },
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    const r = parseClaudeJsonl(body);
    expect(r.messages[0]!.role).toBe("assistant");
  });
});
