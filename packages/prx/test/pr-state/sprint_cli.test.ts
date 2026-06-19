import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { runCli as runCliDirect } from "../../src/pr-state/cli.ts";

describe("prx sprint cli", () => {
  test("sprint init creates state and supports json output", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");
    const logs: string[] = [];
    const exitCode = runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
        "--format",
        "json",
      ],
      { log: (line) => logs.push(line), error: () => {} },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.sprintId).toBe("sprint_2026_w11");
    expect(parsed.goal.metricName).toBe("p90_latency");
    expect(JSON.parse(readFileSync(statePath, "utf8")).sprintId).toBe("sprint_2026_w11");
  });

  test("sprint bind and metric update derived status", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");

    runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
      ],
      { log: () => {}, error: () => {} },
    );

    const bindLogs: string[] = [];
    const bindExit = runCliDirect(
      [
        "sprint",
        "bind",
        "--state",
        statePath,
        "--pr",
        "16230",
        "--ticket",
        "GH-5431",
        "--format",
        "json",
      ],
      { log: (line) => bindLogs.push(line), error: () => {} },
      {
        viewPr: () => ({
          number: 16230,
          state: "OPEN",
          isDraft: false,
          reviewDecision: "APPROVED",
          statusCheckRollup: { state: "SUCCESS" },
          mergeable: "MERGEABLE",
        }),
      },
    );
    expect(bindExit).toBe(0);
    expect(JSON.parse(bindLogs[0]!).bindings.prNumbers).toEqual([16230]);

    const metricLogs: string[] = [];
    const metricExit = runCliDirect(
      [
        "sprint",
        "metric",
        "--state",
        statePath,
        "--baseline",
        "100",
        "--current",
        "85",
        "--format",
        "json",
      ],
      { log: (line) => metricLogs.push(line), error: () => {} },
      {
        viewPr: () => ({
          number: 16230,
          state: "MERGED",
          isDraft: false,
          reviewDecision: "APPROVED",
          statusCheckRollup: { state: "SUCCESS" },
          mergeable: "MERGEABLE",
        }),
      },
    );
    expect(metricExit).toBe(0);
    const metricState = JSON.parse(metricLogs[0]!);
    expect(metricState.derived.outcomeStatus).toBe("met_target");
    expect(metricState.derived.sprintStatus).toBe("complete");
  });

  test("sprint bind requires canonical work-unit identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");
    runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
      ],
      { log: () => {}, error: () => {} },
    );

    const errors: string[] = [];
    const missingLinkExit = runCliDirect(
      ["sprint", "bind", "--state", statePath, "--pr", "16230"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(missingLinkExit).toBe(1);
    expect(errors[0]).toContain("--ticket or --unit is required");

    const mismatchErrors: string[] = [];
    const mismatchExit = runCliDirect(
      [
        "sprint",
        "bind",
        "--state",
        statePath,
        "--pr",
        "16230",
        "--ticket",
        "GH-5431",
        "--unit",
        "GH-5432",
      ],
      { log: () => {}, error: (line) => mismatchErrors.push(line) },
    );
    expect(mismatchExit).toBe(1);
    expect(mismatchErrors[0]).toContain("--ticket and --unit must match");
  });

  test("sprint bind normalizes canonical IDs to uppercase", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");
    runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
      ],
      { log: () => {}, error: () => {} },
    );

    const logs: string[] = [];
    const exitCode = runCliDirect(
      [
        "sprint",
        "bind",
        "--state",
        statePath,
        "--pr",
        "16230",
        "--ticket",
        "gh-5431",
        "--format",
        "json",
      ],
      { log: (line) => logs.push(line), error: () => {} },
      {
        viewPr: () => ({
          number: 16230,
          state: "OPEN",
          isDraft: false,
          reviewDecision: "APPROVED",
          statusCheckRollup: { state: "SUCCESS" },
          mergeable: "MERGEABLE",
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!).bindings.ticketIds).toEqual(["GH-5431"]);
  });

  test("sprint status supports plain and json", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");

    runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
      ],
      { log: () => {}, error: () => {} },
    );

    const plainLogs: string[] = [];
    const plainExit = runCliDirect(["sprint", "status", "--state", statePath], {
      log: (line) => plainLogs.push(line),
      error: () => {},
    });
    expect(plainExit).toBe(0);
    expect(plainLogs[0]).toContain("sprint=sprint_2026_w11");

    const jsonLogs: string[] = [];
    const jsonExit = runCliDirect(["sprint", "status", "--state", statePath, "--format", "json"], {
      log: (line) => jsonLogs.push(line),
      error: () => {},
    });
    expect(jsonExit).toBe(0);
    expect(JSON.parse(jsonLogs[0]!).sprintId).toBe("sprint_2026_w11");
  });

  test("sprint sync-notion supports dry-run and apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-sprint-"));
    const statePath = join(dir, "sprint.json");
    runCliDirect(
      [
        "sprint",
        "init",
        "--state",
        statePath,
        "--id",
        "sprint_2026_w11",
        "--goal",
        "Reduce lag",
        "--metric",
        "p90_latency",
        "--target-delta",
        "-10",
      ],
      { log: () => {}, error: () => {} },
    );

    const dryLogs: string[] = [];
    const dryExit = runCliDirect(["sprint", "sync-notion", "--state", statePath], {
      log: (line) => dryLogs.push(line),
      error: () => {},
    });
    expect(dryExit).toBe(0);
    expect(dryLogs[0]).toContain("WOULD SYNC");

    const applyLogs: string[] = [];
    const applyExit = runCliDirect(
      ["sprint", "sync-notion", "--state", statePath, "--apply", "--format", "json"],
      { log: (line) => applyLogs.push(line), error: () => {} },
    );
    expect(applyExit).toBe(0);
    expect(JSON.parse(applyLogs[0]!).apply).toBe(true);
  });
});
