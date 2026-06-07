// pr-state/dolt-reconcile — detectSchemaConflict (pure) + runDoltReconcileWithResult
// driven through its injected `spawn` seam across modes and step outcomes.

import { describe, expect, test } from "bun:test";

import {
  detectSchemaConflict,
  runDoltReconcileWithResult,
  type DoltReconcileSpawn,
  type DoltReconcileSpawnResult,
} from "../../src/pr-state/dolt-reconcile.ts";

function rec() {
  const lines: string[] = [];
  return { lines, output: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
}

const ok = (stdout = ""): DoltReconcileSpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): DoltReconcileSpawnResult => ({ status: 1, stdout: "", stderr });

// A spawn that picks an outcome per pipeline step (by the bd subcommand).
function spawnFor(map: Partial<Record<string, DoltReconcileSpawnResult>>): DoltReconcileSpawn {
  return (_file, args) => {
    const step = args.find((a) => a === "commit" || a === "pull" || a === "push") ?? "?";
    return map[step] ?? ok();
  };
}

const baseOpts = { repoPath: "/repo", dryRun: false, format: "plain" as const };

describe("detectSchemaConflict", () => {
  test("null/empty stderr → no conflict", () => {
    expect(detectSchemaConflict(null)).toBeNull();
    expect(detectSchemaConflict("")).toBeNull();
  });
  test("non-schema stderr → no conflict", () => {
    expect(detectSchemaConflict("some unrelated error")).toBeNull();
  });
  test("a dolt_schema_conflicts indicator → a schema conflict", () => {
    expect(detectSchemaConflict("error: dolt_schema_conflicts present")).toMatchObject({ kind: "schema" });
  });
  test("a Buffer stderr is decoded", () => {
    expect(detectSchemaConflict(Buffer.from("failed to initialize schema"))).toMatchObject({ kind: "schema" });
  });
});

describe("runDoltReconcileWithResult", () => {
  test("dry-run previews the pipeline without running it", () => {
    const r = rec();
    const { result } = runDoltReconcileWithResult(
      { ...baseOpts, dryRun: true },
      r.output,
      { spawn: (() => { throw new Error("spawn must not run on dry-run"); }) as DoltReconcileSpawn },
    );
    expect(result.steps.every((s) => s.status === "preview")).toBe(true);
  });

  test("full mode with every step succeeding → exit 0", () => {
    const r = rec();
    const { exitCode } = runDoltReconcileWithResult(baseOpts, r.output, { spawn: spawnFor({}) });
    expect(exitCode).toBe(0);
  });

  test("a failing pull step → non-zero exit + a failed step", () => {
    const r = rec();
    const { exitCode, result } = runDoltReconcileWithResult(baseOpts, r.output, {
      spawn: spawnFor({ pull: fail("merge conflict") }),
    });
    expect(exitCode).not.toBe(0);
    expect(result.steps.some((s) => s.status === "failed")).toBe(true);
  });

  test("a schema conflict on push surfaces the schema hint", () => {
    const r = rec();
    const { result } = runDoltReconcileWithResult(baseOpts, r.output, {
      spawn: spawnFor({ push: fail("error: dolt_schema_conflicts on wisps") }),
    });
    expect(JSON.stringify(result)).toContain("schema");
  });

  test("push-only mode does not run the pull step", () => {
    const r = rec();
    const { result } = runDoltReconcileWithResult({ ...baseOpts, mode: "push-only" }, r.output, { spawn: spawnFor({}) });
    expect(result.steps.filter((s) => s.step === "pull" && s.status === "ok")).toHaveLength(0);
  });

  test("pull-only mode does not run the push step", () => {
    const r = rec();
    const { result } = runDoltReconcileWithResult({ ...baseOpts, mode: "pull-only" }, r.output, { spawn: spawnFor({}) });
    expect(result.steps.filter((s) => s.step === "push" && s.status === "ok")).toHaveLength(0);
  });
});
