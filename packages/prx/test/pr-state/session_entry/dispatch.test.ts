// GH-977: dispatchSessionEntryEvent drives sessionEntryMachine to a final
// state and merges PRX_SESSION_CONTEXT into the projection's env so
// `getCurrentSessionContext()` can read it from a child prx process.

import { afterEach, describe, expect, test } from "bun:test";

import { dispatchSessionEntryEvent } from "../../../src/pr-state/session-entry/dispatch.ts";
import { PRX_SESSION_CONTEXT_ENV } from "../../../src/pr-state/session-entry/get-current-session-context.ts";
import {
  resetSessionEntryStderr,
  setSessionEntryStderrSink,
} from "../../../src/machine/machines/session-entry.ts";

afterEach(() => {
  resetSessionEntryStderr();
});

describe("dispatchSessionEntryEvent", () => {
  test("plan event injects PRX_SESSION_CONTEXT=plan and preserves other env keys", () => {
    const restore = setSessionEntryStderrSink(() => {});
    try {
      const profile = dispatchSessionEntryEvent({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-977",
      });
      expect(profile.command).toBe("claude");
      expect(profile.env?.[PRX_SESSION_CONTEXT_ENV]).toBe("plan");
      // GH-1147: plan profile now binds the planner role (was "executor"
      // when bootClaudePlan called buildWorkUnitClaudeInteractiveRuntimeProfile).
      expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");
    } finally {
      restore();
    }
  });

  test("intake event injects PRX_SESSION_CONTEXT=intake", () => {
    const profile = dispatchSessionEntryEvent({ type: "OPEN_INTAKE_SESSION" });
    expect(profile.env?.[PRX_SESSION_CONTEXT_ENV]).toBe("intake");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("intake");
  });

  test("triage event injects PRX_SESSION_CONTEXT=triage", () => {
    const profile = dispatchSessionEntryEvent({ type: "OPEN_TRIAGE_SESSION" });
    expect(profile.env?.[PRX_SESSION_CONTEXT_ENV]).toBe("triage");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("triage");
  });

  test("alias-vs-canonical plan dispatch produces identical projections modulo emission", () => {
    const sink: string[] = [];
    const restore = setSessionEntryStderrSink((line) => sink.push(line));
    try {
      const canonical = dispatchSessionEntryEvent({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-9",
      });
      const aliased = dispatchSessionEntryEvent({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-9",
        viaAlias: true,
      });
      expect(canonical.command).toBe(aliased.command);
      expect(canonical.args).toEqual(aliased.args);
      expect(canonical.env?.[PRX_SESSION_CONTEXT_ENV]).toBe(
        aliased.env?.[PRX_SESSION_CONTEXT_ENV] ?? "",
      );
      // Only the alias path emitted the deprecation hint.
      expect(sink.length).toBe(1);
    } finally {
      restore();
    }
  });
});
