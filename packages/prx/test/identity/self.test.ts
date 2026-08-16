import { describe, expect, test } from "bun:test";

import { resolveSelfOperator } from "../../src/identity/self.ts";

describe("resolveSelfOperator (GH-2012)", () => {
  test("happy path: returns GH login from injected resolveGhLogin", () => {
    const result = resolveSelfOperator({
      resolveGhLogin: () => ({ ok: true, login: "bdelanghe" }),
    });
    expect(result).toEqual({ ok: true, agent: "bdelanghe" });
  });

  test("refusal propagates with message", () => {
    const result = resolveSelfOperator({
      resolveGhLogin: () => ({
        ok: false,
        message: "gh auth status failed — run `gh auth login`",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/gh auth status/);
    }
  });

  test("no env or git side channels — resolver delegates only to gh login", () => {
    let called = 0;
    const result = resolveSelfOperator({
      resolveGhLogin: () => {
        called++;
        return { ok: true, login: "bdelanghe" };
      },
    });
    expect(called).toBe(1);
    expect(result).toEqual({ ok: true, agent: "bdelanghe" });
  });
});
