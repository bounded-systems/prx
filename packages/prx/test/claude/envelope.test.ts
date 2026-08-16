// GH-1095 — `parseClaudeJsonEnvelope` boundary parser tests.

import { describe, expect, test } from "bun:test";

import { parseClaudeJsonEnvelope } from "../../src/claude/envelope.ts";

describe("parseClaudeJsonEnvelope", () => {
  test("parses the legacy single-object shape (CLI < 2.1)", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "hello",
      total_cost_usd: 0.012,
    });
    expect(parseClaudeJsonEnvelope(stdout)).toEqual({
      result: "hello",
      costUsd: 0.012,
    });
  });

  test("parses the stream-array shape (CLI >= 2.1) and picks the terminal result", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init", session_id: "s1", cwd: "/t" },
      { type: "assistant", message: { content: "thinking" } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "final-answer",
        total_cost_usd: 0.04,
      },
    ]);
    expect(parseClaudeJsonEnvelope(stdout)).toEqual({
      result: "final-answer",
      costUsd: 0.04,
    });
  });

  test("array shape: omits costUsd when total_cost_usd is absent", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init", session_id: "s1", cwd: "/t" },
      { type: "result", subtype: "success", result: "no-cost" },
    ]);
    const parsed = parseClaudeJsonEnvelope(stdout);
    expect(parsed.result).toBe("no-cost");
    expect(parsed.costUsd).toBeUndefined();
  });

  test("array with no terminal `result` event throws and lists the observed types", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
    ]);
    expect(() => parseClaudeJsonEnvelope(stdout, "haiku envelope")).toThrow(
      /haiku envelope.*no terminal "result" event.*types: system,assistant/,
    );
  });

  test("envelope marked is_error throws an error envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "oops",
    });
    expect(() => parseClaudeJsonEnvelope(stdout)).toThrow(/error envelope/);
  });

  test("envelope with `error` field throws", () => {
    const stdout = JSON.stringify({
      type: "result",
      error: { message: "rate-limited" },
    });
    expect(() => parseClaudeJsonEnvelope(stdout)).toThrow(/error envelope/);
  });

  test("missing `result` string throws (object shape)", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success" });
    expect(() => parseClaudeJsonEnvelope(stdout, "haiku envelope")).toThrow(
      /haiku envelope.*missing string "result" field/,
    );
  });

  test("missing `result` string throws (array shape)", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success" },
    ]);
    expect(() => parseClaudeJsonEnvelope(stdout)).toThrow(
      /malformed result event|missing string "result" field/,
    );
  });

  test("non-JSON stdout throws with the operator-supplied prefix", () => {
    expect(() => parseClaudeJsonEnvelope("not json at all", "claude MCP resolver")).toThrow(
      /claude MCP resolver: could not parse/,
    );
  });

  test("default error prefix is `claude envelope`", () => {
    expect(() => parseClaudeJsonEnvelope("garbage")).toThrow(/claude envelope: could not parse/);
  });
});
