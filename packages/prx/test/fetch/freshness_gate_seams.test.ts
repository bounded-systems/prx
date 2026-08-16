// GH-1786 — the freshness-gate's bd/gh-backed production seams. The pure
// classifiers are covered elsewhere; these drive the watermark reader and the
// refresh trigger through injected seams (go/skip/fail/error) without a live
// substrate.

import { describe, expect, test } from "bun:test";

import {
  defaultSubstrateRefresher,
  readSubstrateWatermark,
} from "../../src/fetch/freshness-gate.ts";
import { FetchGhIssuesError } from "../../src/fetch/gh-issues.ts";

describe("readSubstrateWatermark", () => {
  test("returns the watermark's since value", () => {
    expect(
      readSubstrateWatermark("/cwd", (() => ({ since: "2026-06-01T00:00:00Z" })) as never),
    ).toBe("2026-06-01T00:00:00Z");
  });
  test("passes through a null watermark", () => {
    expect(readSubstrateWatermark("/cwd", (() => ({ since: null })) as never)).toBeNull();
  });
  test("a thrown reader (bd unreachable) is swallowed → null", () => {
    expect(
      readSubstrateWatermark("/cwd", (() => {
        throw new Error("bd down");
      }) as never),
    ).toBeNull();
  });
});

describe("defaultSubstrateRefresher", () => {
  const arg = { repo: "owner/repo", cwd: "/cwd" };
  const plan = (decision: string, rationale = "r") =>
    (() => ({ plan: { decision, rationale } })) as never;

  test("a 'go' decision → ok", () => {
    expect(defaultSubstrateRefresher(arg, plan("go"))).toEqual({ ok: true });
  });
  test("a 'skip' decision → stale-passthrough reason", () => {
    expect(defaultSubstrateRefresher(arg, plan("skip", "budget"))).toEqual({
      ok: false,
      reason: "fetch skip: budget",
    });
  });
  test("a 'fail' decision → stale-passthrough reason", () => {
    expect(defaultSubstrateRefresher(arg, plan("fail", "boom")).ok).toBe(false);
  });
  test("a FetchGhIssuesError is rendered with its code", () => {
    const r = defaultSubstrateRefresher(arg, (() => {
      throw new FetchGhIssuesError("nope", "WATERMARK_READ_FAILED");
    }) as never);
    expect(r).toEqual({ ok: false, reason: "fetch WATERMARK_READ_FAILED: nope" });
  });
  test("a generic error surfaces its message", () => {
    const r = defaultSubstrateRefresher({ repo: undefined, cwd: "/cwd" }, (() => {
      throw new Error("kaboom");
    }) as never);
    expect(r).toEqual({ ok: false, reason: "kaboom" });
  });
});
