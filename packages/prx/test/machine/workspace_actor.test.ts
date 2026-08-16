// GH-1978 — workspace actor catalog delta. Foundation entry for the
// workspace lifecycle actor that retires wtctl's
// sync / ignore sync / up / down surface. Membership/ownership-based
// assertions only — emit() action strings are stripped from the
// xstate-system-ts projection so the catalog/event-owner/scope/
// invariant entries are the durable surface.

import { describe, expect, test } from "bun:test";

import {
  actorForEvent,
  actorScopes,
  eventOwnerMap,
  toolActorCatalog,
  toolActors,
} from "../../src/machine/actors.ts";
import { invariantSpecs } from "@bounded-systems/machine-schema";

describe("GH-1978: workspace actor catalog entry", () => {
  test("workspace is registered in toolActors", () => {
    expect(toolActors).toContain("workspace");
  });

  test("toolActorCatalog.workspace has the execution/cli/workspace_lifecycle shape", () => {
    const workspace = toolActorCatalog.workspace;
    expect(workspace.actor).toBe("workspace");
    expect(workspace.tier).toBe("execution");
    expect(workspace.kind).toBe("cli");
    expect(workspace.domain).toBe("workspace_lifecycle");
  });

  test("workspace emits the eight lifecycle events", () => {
    const expected = new Set([
      "WORKSPACE_RESERVED",
      "WORKSPACE_MATERIALIZED",
      "WORKSPACE_PREPARED",
      "WORKSPACE_SYNCED",
      "WORKSPACE_SERVICES_STARTED",
      "WORKSPACE_SERVICES_STOPPED",
      "WORKSPACE_TORN_DOWN",
      "WORKSPACE_OP_FAILED",
    ]);
    expect(new Set(toolActorCatalog.workspace.emits)).toEqual(expected);
  });

  test("workspace accepts the six verbs", () => {
    expect(new Set(toolActorCatalog.workspace.accepts)).toEqual(
      new Set(["reserve", "materialize", "prepare", "sync", "service", "teardown"]),
    );
  });

  test("workspace is included in the workflow scope (not the pr scope)", () => {
    expect(actorScopes.workflow).toContain("workspace");
    expect(actorScopes.pr).not.toContain("workspace");
  });

  test("eventOwnerMap routes every WORKSPACE_* event to the workspace actor", () => {
    const workspaceEvents = [
      "WORKSPACE_RESERVED",
      "WORKSPACE_MATERIALIZED",
      "WORKSPACE_PREPARED",
      "WORKSPACE_SYNCED",
      "WORKSPACE_SERVICES_STARTED",
      "WORKSPACE_SERVICES_STOPPED",
      "WORKSPACE_TORN_DOWN",
      "WORKSPACE_OP_FAILED",
    ];
    for (const evt of workspaceEvents) {
      expect(eventOwnerMap[evt]).toBe("workspace");
      expect(actorForEvent(evt)).toBe("workspace");
    }
  });
});

describe("GH-1978: I-WS1..I-WS4 invariants", () => {
  test("invariantSpecs contains all four workspace invariants", () => {
    expect(invariantSpecs.some((s) => s.startsWith("I-WS1:"))).toBe(true);
    expect(invariantSpecs.some((s) => s.startsWith("I-WS2:"))).toBe(true);
    expect(invariantSpecs.some((s) => s.startsWith("I-WS3:"))).toBe(true);
    expect(invariantSpecs.some((s) => s.startsWith("I-WS4:"))).toBe(true);
  });

  test("I-WS1 mentions reserve as the only entry", () => {
    const i = invariantSpecs.find((s) => s.startsWith("I-WS1:"));
    expect(i).toContain("reserve");
  });

  test("I-WS2 mentions atomic writes", () => {
    const i = invariantSpecs.find((s) => s.startsWith("I-WS2:"));
    expect(i).toMatch(/atomic|tmp \+ rename/);
  });

  test("I-WS3 mentions the no-profile auto-mode no-op", () => {
    const i = invariantSpecs.find((s) => s.startsWith("I-WS3:"));
    expect(i).toMatch(/auto|profile/);
  });

  test("I-WS4 mentions workspace_id + uow_id", () => {
    const i = invariantSpecs.find((s) => s.startsWith("I-WS4:"));
    expect(i).toContain("workspace_id");
    expect(i).toContain("uow_id");
  });
});

describe("GH-2281: I-WS5 fail-closed mainx guard invariant", () => {
  test("invariantSpecs contains the I-WS5 spec", () => {
    expect(invariantSpecs.some((s) => s.startsWith("I-WS5:"))).toBe(true);
  });

  test("I-WS5 mentions the read-only mainx replica and fails closed", () => {
    const i = invariantSpecs.find((s) => s.startsWith("I-WS5:"));
    expect(i).toContain("mainx");
    expect(i).toMatch(/read-only/);
    expect(i).toMatch(/fails? closed/);
  });
});
