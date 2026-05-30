import { describe, expect, test } from "bun:test";

import {
  formatIntakeStatus,
  runIntakeStatus,
  type IntakeStatusOptions,
  type IntakeStatusResult,
} from "../../src/intake/intake-status.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { FallbackIssue } from "../../src/pr-state/github.ts";

function makeOptions(
  overrides: Partial<IntakeStatusOptions> = {},
): IntakeStatusOptions {
  return {
    format: "plain",
    limit: 0,
    includeIntentional: false,
    rateLimit: false,
    ...overrides,
  };
}

function emptyResult(
  overrides: Partial<IntakeStatusResult> = {},
): IntakeStatusResult {
  return {
    repo: "o/r",
    totalOpen: 0,
    totalUntriaged: 0,
    totalReverseOrphans: 0,
    totalDrift: 0,
    untriaged: [],
    reverseOrphans: [],
    drift: [],
    ...overrides,
  };
}

describe("formatIntakeStatus", () => {
  test("json format round-trips the result shape", () => {
    const result = emptyResult({ totalOpen: 5 });
    expect(JSON.parse(formatIntakeStatus(result, "json"))).toEqual(result);
  });

  test("plain format shows clean message when nothing unfiled or drifted", () => {
    const result = emptyResult({ totalOpen: 12 });
    expect(formatIntakeStatus(result, "plain")).toBe(
      "All 12 open issues in o/r have a beads row with no reverse orphans or pair drift.",
    );
  });

  test("plain format lists unfiled GH issues", () => {
    const result = emptyResult({
      totalOpen: 2,
      totalUntriaged: 1,
      untriaged: [
        { number: 7, title: "fresh idea", url: "u", labels: [] },
      ],
    });
    const text = formatIntakeStatus(result, "plain");
    expect(text).toContain("1 unfiled · 0 reverse-orphan · 0 drift");
    expect(text).toContain("Unfiled (1):");
    expect(text).toContain("GH-7");
  });
});

describe("runIntakeStatus", () => {
  test("untriaged = open GH issues with no beads row (set difference)", () => {
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          { number: 1, title: "filed", url: "https://github.com/o/r/issues/1", labels: [] },
          { number: 2, title: "fresh", url: "https://github.com/o/r/issues/2", labels: [] },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-1", title: "filed", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/1" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as IntakeStatusResult;
    expect(result.totalOpen).toBe(2);
    expect(result.totalUntriaged).toBe(1);
    expect(result.untriaged[0]!.number).toBe(2);
  });

  test("missing labels alone does NOT count as unfiled (intake's job is filing, not labeling)", () => {
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          { number: 1, title: "no labels", url: "u", labels: [] },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-1", title: "no labels", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/1" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as IntakeStatusResult;
    expect(result.totalUntriaged).toBe(0);
  });

  test("reverseOrphans and drift mirror triage status semantics", () => {
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          { number: 100, title: "Foo", url: "u", labels: [] },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-100", title: "Bar", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/100" },
            { id: "ai-home-rev", title: "lonely", status: "open", priority: 2, issue_type: "task", external_ref: null },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as IntakeStatusResult;
    expect(result.totalReverseOrphans).toBe(1);
    expect(result.totalDrift).toBe(1);
    expect(result.totalUntriaged).toBe(0);
  });

  test("--rate-limit flag absent → no rateLimit field, no refresh/estimate calls", () => {
    let refreshCalls = 0;
    let estimateCalls = 0;
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
        refreshBudget: ((() => {
          refreshCalls += 1;
          return null;
        }) as never),
        estimateSweepCost: ((() => {
          estimateCalls += 1;
          return { perBucket: { core: 0, graphql: 0, search: 0 }, sample: { calls: 0, avg: 2 } };
        }) as never),
      },
    );
    const result = JSON.parse(logs[0]!) as IntakeStatusResult;
    expect(result.rateLimit).toBeUndefined();
    expect(refreshCalls).toBe(0);
    expect(estimateCalls).toBe(0);
  });

  test("--rate-limit flag set → snapshots + estimate populated; queueSize sums all three", () => {
    const snapshots = [
      { bucket: "core" as const, limit: 5000, remaining: 4994, resetAt: 1700000000000, fetchedAt: 0 },
      { bucket: "graphql" as const, limit: 5000, remaining: 4823, resetAt: 1700000000000, fetchedAt: 0 },
      { bucket: "search" as const, limit: 30, remaining: 29, resetAt: 1700000000000, fetchedAt: 0 },
    ];
    let receivedQueue = -1;
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "json", rateLimit: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          { number: 1, title: "fresh", url: "u", labels: [] },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            // 1 reverse orphan
            { id: "ai-home-rev", title: "lonely", status: "open", priority: 2, issue_type: "task", external_ref: null },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
        refreshBudget: (() => snapshots) as never,
        estimateSweepCost: ((queueSize: number) => {
          receivedQueue = queueSize;
          return {
            perBucket: { core: 0, graphql: 6, search: 0 },
            sample: { calls: 18, avg: 2.0 },
          };
        }) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as IntakeStatusResult;
    expect(result.rateLimit).toBeDefined();
    expect(result.rateLimit!.snapshots).toEqual(snapshots);
    // 1 unfiled + 1 reverse orphan + 0 drift = 2
    expect(receivedQueue).toBe(2);
  });

  test("plain output includes GitHub budget block when rateLimit set", () => {
    const logs: string[] = [];
    runIntakeStatus(
      makeOptions({ repo: "o/r", format: "plain", rateLimit: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
        refreshBudget: (() =>
          [
            { bucket: "core", limit: 5000, remaining: 4994, resetAt: 1700000000000, fetchedAt: 0 },
            { bucket: "graphql", limit: 5000, remaining: 4823, resetAt: 1700000000000, fetchedAt: 0 },
            { bucket: "search", limit: 30, remaining: 29, resetAt: 1700000000000, fetchedAt: 0 },
          ]) as never,
        estimateSweepCost: (() => ({
          perBucket: { core: 0, graphql: 0, search: 0 },
          sample: { calls: 0, avg: 2 },
        })) as never,
      },
    );
    const text = logs.join("\n");
    expect(text).toContain("GitHub budget:");
    expect(text).toContain("graphql:  4823/5000");
    expect(text).toMatch(/cold sample, fallback avg 2\.0 pts\/issue/);
  });
});
