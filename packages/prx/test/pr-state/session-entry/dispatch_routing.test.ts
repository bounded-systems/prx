// pr-state/session-entry/dispatch — dispatchFromArgvWithRouting's status switch,
// driven through the injected runRepoRouter seam (no real repo router).

import { describe, expect, test } from "bun:test";

import { dispatchFromArgvWithRouting } from "../../../src/pr-state/session-entry/dispatch.ts";

const ARGV = ["plan", "session", "GH-977"]; // → OPEN_PLAN_SESSION, no recursion guard

function route(result: unknown) {
  return dispatchFromArgvWithRouting(ARGV, {
    cwd: () => "/repo",
    runRepoRouter: (() => result) as never,
  });
}

describe("dispatchFromArgvWithRouting", () => {
  test("throws when no SessionEntryEvent matches the argv", () => {
    expect(() => dispatchFromArgvWithRouting(["totally", "bogus"])).toThrow(
      /no SessionEntryEvent matched/,
    );
  });

  test("local → a profile for the original event", () => {
    expect(route({ status: "local", prefix: "io.github" }).kind).toBe("profile");
  });

  test("unrecognized → a profile for the original event", () => {
    expect(route({ status: "unrecognized" }).kind).toBe("profile");
  });

  test("refused-no-pin → refused(no-pin) with the hint", () => {
    const r = route({ status: "refused-no-pin", prefix: "p", hint: "pin it" });
    expect(r).toMatchObject({ kind: "refused", reason: "no-pin", hint: "pin it" });
  });

  test("refused-conflict → refused(conflict) with the hint", () => {
    const r = route({ status: "refused-conflict", prefix: "p", hint: "resolve it" });
    expect(r).toMatchObject({ kind: "refused", reason: "conflict", hint: "resolve it" });
  });

  test("failed → failed with the reason", () => {
    const r = route({ status: "failed", reason: "boom" });
    expect(r).toMatchObject({ kind: "failed", reason: "boom" });
  });

  test("routed (no redispatch ran) → routed via the original-event fallback", () => {
    const r = route({ status: "routed", repo: { name: "x" }, barePath: "/bare/x" });
    expect(r.kind).toBe("routed");
  });

  test("routed (redispatch ran) → routed with the redispatched profile", () => {
    const r = dispatchFromArgvWithRouting(ARGV, {
      cwd: () => "/repo",
      runRepoRouter: ((
        _input: unknown,
        deps: { redispatchOpenPlanSession: (a: unknown) => void },
      ) => {
        // The router invokes the recursion-guarded redispatch, then reports routed.
        deps.redispatchOpenPlanSession({ repo: { name: "x" }, barePath: "/bare/x" });
        return { status: "routed", repo: { name: "x" }, barePath: "/bare/x" };
      }) as never,
    });
    expect(r.kind).toBe("routed");
  });
});
