// GH-1603 — fetchMachine transition tests.
//
// Drives the per-run lifecycle (idle → projecting → fetching → writing →
// advancing → completed | failed_mid_fetch) and asserts that context
// fields capture the orchestrator's I-F4 / I-F5 / I-F6 invariants at
// each step.

import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import { fetchMachine, type FetchRunContext } from "../../../src/machine/machines/fetch.ts";

function startMachine() {
  const actor = createActor(fetchMachine);
  actor.start();
  return actor;
}

function snapshot(actor: ReturnType<typeof startMachine>): {
  value: unknown;
  context: FetchRunContext;
} {
  const snap = actor.getSnapshot();
  return { value: snap.value, context: snap.context };
}

describe("fetchMachine — success path", () => {
  test("idle → projecting → fetching → writing → advancing → completed", () => {
    const actor = startMachine();
    expect(snapshot(actor).value).toBe("idle");

    actor.send({
      type: "FETCH_PLAN_COMPUTED",
      totalPagesExpected: 1,
      dryRun: false,
    });
    expect(snapshot(actor).value).toBe("projecting");
    expect(snapshot(actor).context.totalPagesExpected).toBe(1);

    actor.send({
      type: "FETCH_DRY_RUN_DECIDED",
      decision: "go",
      dryRun: false,
    });
    expect(snapshot(actor).value).toBe("fetching");
    expect(snapshot(actor).context.decision).toBe("go");

    actor.send({
      type: "FETCH_PAGE_FETCHED",
      pageNumber: 1,
      pointsSpent: 5,
      nodeCount: 2,
    });
    expect(snapshot(actor).value).toBe("writing");
    expect(snapshot(actor).context.pointsSpentTotal).toBe(5);

    actor.send({
      type: "FETCH_PAGE_WRITTEN",
      pageNumber: 1,
      rowsWritten: 2,
      lastUpdatedAt: "2026-05-13T11:00:00Z",
    });
    expect(snapshot(actor).value).toBe("advancing");
    expect(snapshot(actor).context.pagesCommitted).toBe(1);
    expect(snapshot(actor).context.rowsWrittenTotal).toBe(2);
    expect(snapshot(actor).context.lastSuccessfulUpdatedAt).toBe("2026-05-13T11:00:00Z");

    actor.send({
      type: "FETCH_WATERMARK_ADVANCED",
      newSince: "2026-05-13T11:00:00Z",
      pageNumber: 1,
      hasMorePages: false,
    });
    expect(snapshot(actor).value).toBe("completed");
    expect(snapshot(actor).context.hasMorePages).toBe(false);
  });

  test("hasMorePages guard returns to fetching for page 2", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 2, dryRun: false });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "go", dryRun: false });
    actor.send({ type: "FETCH_PAGE_FETCHED", pageNumber: 1, pointsSpent: 5, nodeCount: 1 });
    actor.send({
      type: "FETCH_PAGE_WRITTEN",
      pageNumber: 1,
      rowsWritten: 1,
      lastUpdatedAt: "2026-05-13T10:00:00Z",
    });
    actor.send({
      type: "FETCH_WATERMARK_ADVANCED",
      newSince: "2026-05-13T10:00:00Z",
      pageNumber: 1,
      hasMorePages: true,
    });
    expect(snapshot(actor).value).toBe("fetching");
    expect(snapshot(actor).context.lastSuccessfulUpdatedAt).toBe("2026-05-13T10:00:00Z");
  });
});

describe("fetchMachine — dry-run / skip short-circuits", () => {
  test("dryRun=true terminates in `completed` without fetching", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 1, dryRun: true });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "go", dryRun: true });
    expect(snapshot(actor).value).toBe("completed");
  });

  test("decision=skip terminates in `completed` without fetching", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 0, dryRun: false });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "skip", dryRun: false });
    expect(snapshot(actor).value).toBe("completed");
  });

  test("decision=fail terminates in `failed_mid_fetch`", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 1, dryRun: false });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "fail", dryRun: false });
    expect(snapshot(actor).value).toBe("failed_mid_fetch");
  });
});

describe("fetchMachine — failure paths", () => {
  test("page fetch failure mid-run captures lastSuccessfulUpdatedAt", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 2, dryRun: false });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "go", dryRun: false });
    actor.send({ type: "FETCH_PAGE_FETCHED", pageNumber: 1, pointsSpent: 5, nodeCount: 1 });
    actor.send({
      type: "FETCH_PAGE_WRITTEN",
      pageNumber: 1,
      rowsWritten: 1,
      lastUpdatedAt: "2026-05-13T10:00:00Z",
    });
    actor.send({
      type: "FETCH_WATERMARK_ADVANCED",
      newSince: "2026-05-13T10:00:00Z",
      pageNumber: 1,
      hasMorePages: true,
    });
    actor.send({
      type: "FETCH_PAGE_FAILED",
      pageNumber: 2,
      code: "GH_GRAPHQL_FAILED",
      lastSuccessfulUpdatedAt: "2026-05-13T10:00:00Z",
    });
    expect(snapshot(actor).value).toBe("failed_mid_fetch");
    expect(snapshot(actor).context.lastSuccessfulUpdatedAt).toBe("2026-05-13T10:00:00Z");
    expect(snapshot(actor).context.pagesCommitted).toBe(1);
  });

  test("page write failure captures pagesCommitted = 0", () => {
    const actor = startMachine();
    actor.send({ type: "FETCH_PLAN_COMPUTED", totalPagesExpected: 1, dryRun: false });
    actor.send({ type: "FETCH_DRY_RUN_DECIDED", decision: "go", dryRun: false });
    actor.send({ type: "FETCH_PAGE_FETCHED", pageNumber: 1, pointsSpent: 5, nodeCount: 1 });
    actor.send({
      type: "FETCH_PAGE_FAILED",
      pageNumber: 1,
      code: "FETCH_WRITE_FAILED",
      lastSuccessfulUpdatedAt: null,
    });
    expect(snapshot(actor).value).toBe("failed_mid_fetch");
    expect(snapshot(actor).context.pagesCommitted).toBe(0);
    expect(snapshot(actor).context.lastSuccessfulUpdatedAt).toBeNull();
  });
});
