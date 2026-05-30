// GH-977: pure argv → SessionEntryEvent mapping. Single home for the
// session-entry alias rule.

import { describe, expect, test } from "bun:test";

import {
  PRX_BACKGROUND_DETACHED_REFUSAL,
  SessionEntryArgvError,
  eventForArgv,
} from "../../../src/pr-state/session-entry/event-for-argv.ts";

describe("eventForArgv", () => {
  test("plan session <id> → canonical OPEN_PLAN_SESSION", () => {
    expect(eventForArgv(["plan", "session", "GH-977"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-977",
    });
  });

  test("session open <id> → alias OPEN_PLAN_SESSION (viaAlias: true)", () => {
    expect(eventForArgv(["session", "open", "GH-977"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-977",
      viaAlias: true,
    });
  });

  // GH-2380: the four ops profiles use the canonical `agent` verb; default
  // is headless (no `interaction` field), `--interactive` is the opt-in.
  test("intake agent → OPEN_INTAKE_SESSION (headless default)", () => {
    expect(eventForArgv(["intake", "agent"])).toEqual({
      type: "OPEN_INTAKE_SESSION",
    });
  });

  test("intake agent --interactive → OPEN_INTAKE_SESSION interaction:interactive", () => {
    expect(eventForArgv(["intake", "agent", "--interactive"])).toEqual({
      type: "OPEN_INTAKE_SESSION",
      interaction: "interactive",
    });
  });

  test("triage agent → OPEN_TRIAGE_SESSION (headless default)", () => {
    expect(eventForArgv(["triage", "agent"])).toEqual({
      type: "OPEN_TRIAGE_SESSION",
    });
  });

  test("triage agent --interactive → OPEN_TRIAGE_SESSION interaction:interactive", () => {
    expect(eventForArgv(["triage", "agent", "--interactive"])).toEqual({
      type: "OPEN_TRIAGE_SESSION",
      interaction: "interactive",
    });
  });

  test("submit agent <id> → OPEN_SUBMIT_SESSION (GH-1740 + GH-1900 work-unit-bound)", () => {
    expect(eventForArgv(["submit", "agent", "GH-1767"])).toEqual({
      type: "OPEN_SUBMIT_SESSION",
      workUnitId: "GH-1767",
    });
  });

  test("submit agent <id> --interactive → OPEN_SUBMIT_SESSION interaction:interactive", () => {
    expect(eventForArgv(["submit", "agent", "GH-1767", "--interactive"])).toEqual({
      type: "OPEN_SUBMIT_SESSION",
      workUnitId: "GH-1767",
      interaction: "interactive",
    });
  });

  test("submit agent without id → null (parser must reject upstream) (GH-1900)", () => {
    expect(eventForArgv(["submit", "agent"])).toBeNull();
    expect(eventForArgv(["submit", "agent", ""])).toBeNull();
  });

  test("author agent <id> → OPEN_AUTHOR_SESSION (GH-1206)", () => {
    expect(eventForArgv(["author", "agent", "GH-1206"])).toEqual({
      type: "OPEN_AUTHOR_SESSION",
      workUnitId: "GH-1206",
    });
  });

  test("author agent <id> --interactive → OPEN_AUTHOR_SESSION interaction:interactive", () => {
    expect(eventForArgv(["author", "agent", "GH-1206", "--interactive"])).toEqual({
      type: "OPEN_AUTHOR_SESSION",
      workUnitId: "GH-1206",
      interaction: "interactive",
    });
  });

  test("author agent without id → null (parser must reject upstream)", () => {
    expect(eventForArgv(["author", "agent"])).toBeNull();
    expect(eventForArgv(["author", "agent", ""])).toBeNull();
  });

  test("plan session without id → null (parser must reject upstream)", () => {
    expect(eventForArgv(["plan", "session"])).toBeNull();
    expect(eventForArgv(["plan", "session", ""])).toBeNull();
  });

  test("session open without id → null", () => {
    expect(eventForArgv(["session", "open"])).toBeNull();
    expect(eventForArgv(["session", "open", ""])).toBeNull();
  });

  test("unrelated argvs → null", () => {
    expect(eventForArgv([])).toBeNull();
    expect(eventForArgv(["help"])).toBeNull();
    expect(eventForArgv(["status"])).toBeNull();
    expect(eventForArgv(["plan", "GH-1"])).toBeNull();
    expect(eventForArgv(["session", "GH-1"])).toBeNull();
  });

  test("alias and canonical plan paths agree on workUnitId", () => {
    const canonical = eventForArgv(["plan", "session", "GH-9"]);
    const aliased = eventForArgv(["session", "open", "GH-9"]);
    expect(canonical?.type).toBe("OPEN_PLAN_SESSION");
    expect(aliased?.type).toBe("OPEN_PLAN_SESSION");
    if (
      canonical?.type === "OPEN_PLAN_SESSION" &&
      aliased?.type === "OPEN_PLAN_SESSION"
    ) {
      expect(canonical.workUnitId).toBe(aliased.workUnitId);
      expect(canonical.viaAlias).toBeUndefined();
      expect(aliased.viaAlias).toBe(true);
    }
  });

  // GH-1661: --repo flag threading
  test("plan session GH-X --repo foo → repoCtx.repo = foo (trailing flag)", () => {
    expect(eventForArgv(["plan", "session", "GH-X", "--repo", "foo"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      repoCtx: { repo: "foo" },
    });
  });

  test("plan session --repo foo GH-X → repoCtx.repo = foo (leading flag)", () => {
    expect(eventForArgv(["plan", "session", "--repo", "foo", "GH-X"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      repoCtx: { repo: "foo" },
    });
  });

  test("plan session --repo=foo GH-X → repoCtx.repo = foo (equals form)", () => {
    expect(eventForArgv(["plan", "session", "--repo=foo", "GH-X"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      repoCtx: { repo: "foo" },
    });
  });

  test("session open GH-X --repo foo → alias with repoCtx", () => {
    expect(eventForArgv(["session", "open", "GH-X", "--repo", "foo"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      viaAlias: true,
      repoCtx: { repo: "foo" },
    });
  });

  test("plan session without --repo → no repoCtx on event", () => {
    const event = eventForArgv(["plan", "session", "GH-X"]);
    expect(event).toEqual({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-X" });
  });

  // GH-2014: --background and --detached refusal
  test("plan session GH-X --background → attachMode: background", () => {
    expect(eventForArgv(["plan", "session", "GH-X", "--background"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      attachMode: "background",
    });
  });

  test("plan session GH-X (no flag) → attachMode field absent (foreground default)", () => {
    const event = eventForArgv(["plan", "session", "GH-X"]);
    expect(event).toEqual({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-X" });
  });

  test("plan session GH-X --detached → typed refusal pointing at --background", () => {
    expect(() => eventForArgv(["plan", "session", "GH-X", "--detached"])).toThrow(
      SessionEntryArgvError,
    );
    try {
      eventForArgv(["plan", "session", "GH-X", "--detached"]);
    } catch (err) {
      expect(err).toBeInstanceOf(SessionEntryArgvError);
      expect((err as Error).message).toBe(PRX_BACKGROUND_DETACHED_REFUSAL);
      expect((err as Error).message).toContain("--background");
    }
  });

  test("session open GH-X --background → alias with attachMode: background", () => {
    expect(eventForArgv(["session", "open", "GH-X", "--background"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      viaAlias: true,
      attachMode: "background",
    });
  });

  test("plan session GH-X --background --repo foo → both attachMode and repoCtx", () => {
    expect(eventForArgv(["plan", "session", "GH-X", "--background", "--repo", "foo"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      repoCtx: { repo: "foo" },
      attachMode: "background",
    });
  });

  // GH-1421: --source flag threading
  test("plan session GH-X --source notion → sourceCtx.source = notion (trailing flag)", () => {
    expect(eventForArgv(["plan", "session", "GH-X", "--source", "notion"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      sourceCtx: { source: "notion" },
    });
  });

  test("plan session --source=notion GH-X → sourceCtx.source = notion (equals form)", () => {
    expect(eventForArgv(["plan", "session", "--source=notion", "GH-X"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      sourceCtx: { source: "notion" },
    });
  });

  test("session open GH-X --source notion → alias with sourceCtx", () => {
    expect(eventForArgv(["session", "open", "GH-X", "--source", "notion"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      viaAlias: true,
      sourceCtx: { source: "notion" },
    });
  });

  test("plan session GH-X --repo foo --source notion → both repoCtx and sourceCtx", () => {
    expect(eventForArgv(["plan", "session", "GH-X", "--repo", "foo", "--source", "notion"])).toEqual({
      type: "OPEN_PLAN_SESSION",
      workUnitId: "GH-X",
      repoCtx: { repo: "foo" },
      sourceCtx: { source: "notion" },
    });
  });

  test("plan session without --source → no sourceCtx on event", () => {
    const event = eventForArgv(["plan", "session", "GH-X"]);
    expect(event).toEqual({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-X" });
  });
});
