/**
 * Tests for bd schema drift probe + repair (GH-1152).
 *
 * Runner is injected so these never spawn a real `bd` binary.
 */
import { describe, expect, test } from "bun:test";

import { probeBdSchema, repairBdSchema, type BdRunner } from "../../src/beads/schema_repair.ts";

const STARTED_AT_STDERR =
  "Error: failed to search issues: search issues:\n" +
  '  Error 1105 (HY000): column "started_at" could not be found in any table in scope\n';

function constantRunner(result: { exitCode: number; stdout?: string; stderr?: string }): BdRunner {
  return () => ({
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

function sequenceRunner(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>): {
  runner: BdRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const runner: BdRunner = (args) => {
    calls.push(args);
    const r = results[i++] ?? { exitCode: 0 };
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

describe("probeBdSchema", () => {
  test("returns healthy when bd stats exits 0", () => {
    const result = probeBdSchema("/repo", constantRunner({ exitCode: 0 }));
    expect(result.status).toBe("healthy");
  });

  test("returns drift_detected when stderr contains the started_at signature", () => {
    const result = probeBdSchema(
      "/repo",
      constantRunner({ exitCode: 1, stderr: STARTED_AT_STDERR }),
    );
    expect(result.status).toBe("drift_detected");
    expect(result.errorClass).toBe("started_at_missing");
    expect(result.rawStderr).toContain("started_at");
  });

  test("returns probe_failed when stderr does not match the drift signature", () => {
    const result = probeBdSchema(
      "/repo",
      constantRunner({ exitCode: 1, stderr: "Error: database not found" }),
    );
    expect(result.status).toBe("probe_failed");
    expect(result.errorClass).toBe("unknown");
  });
});

describe("repairBdSchema", () => {
  test("returns already_healthy when first bd stats succeeds (single call)", () => {
    const { runner, calls } = sequenceRunner([{ exitCode: 0 }]);
    const result = repairBdSchema("/repo", runner);
    expect(result.status).toBe("already_healthy");
    expect(calls).toHaveLength(1);
  });

  test("returns repaired when drift triggers compat migration on first call", () => {
    const { runner, calls } = sequenceRunner([
      { exitCode: 1, stderr: STARTED_AT_STDERR },
      { exitCode: 0 },
    ]);
    const result = repairBdSchema("/repo", runner);
    expect(result.status).toBe("repaired");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["stats", "--json"]);
    expect(calls[1]).toEqual(["stats", "--json"]);
  });

  test("returns repair_failed when drift persists after the trigger", () => {
    const { runner } = sequenceRunner([
      { exitCode: 1, stderr: STARTED_AT_STDERR },
      { exitCode: 1, stderr: STARTED_AT_STDERR },
    ]);
    const result = repairBdSchema("/repo", runner);
    expect(result.status).toBe("repair_failed");
    expect(result.message).toContain("started_at");
  });

  test("returns repair_failed without retry on a non-drift error", () => {
    const { runner, calls } = sequenceRunner([
      { exitCode: 1, stderr: "Error: connection refused" },
    ]);
    const result = repairBdSchema("/repo", runner);
    expect(result.status).toBe("repair_failed");
    expect(calls).toHaveLength(1);
  });
});
