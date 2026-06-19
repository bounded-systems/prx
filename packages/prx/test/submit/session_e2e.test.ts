// GH-1900: round-trip — write `<UoW>:submit@ready` via the schema helpers,
// then dispatch `prx submit publish --from-cas <ref> --dry-run` through
// `runCli` and assert the printed plan reads the artifact and projects the
// push/PR plan.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { writeSubmitArtifact, type SubmitArtifact } from "../../src/submit/artifact.schema.ts";

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_CAS_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
  "PRX_OPERATOR_CONFIG_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
  "XDG_STATE_HOME",
  "HOME",
] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const HEX40 = "1234567890abcdef1234567890abcdef12345678";
const HEX64 = "0".repeat(64);

function artifact(): SubmitArtifact {
  return {
    workUnitId: "GH-1900",
    baseRef: "main",
    baseSha: HEX40,
    tree: { sha: HEX40 },
    patch: { sha: `sha256:${HEX64}`, bytes: 0 },
    summary: "e2e handoff",
    createdAt: "2026-05-17T00:00:00.000Z",
  };
}

describe("prx submit publish e2e (GH-1900)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-e2e-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("write ready artifact → runCli publish --dry-run prints the push+PR plan", async () => {
    await writeSubmitArtifact({ artifact: artifact(), slot: "ready" });

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    };

    const exit = await runCli(
      ["submit", "publish", "--from-cas", "GH-1900:submit@ready", "--dry-run", "--format", "json"],
      output,
      {},
    );

    expect(errors).toEqual([]);
    expect(exit).toBe(0);
    expect(logs.length).toBe(1);

    const parsed = JSON.parse(logs[0]!) as {
      fromCas: string;
      dryRun: boolean;
      artifact: { workUnitId: string; tree: { sha: string } };
      steps: Array<{ kind: string; argv?: string[]; ref?: string }>;
    };
    expect(parsed.fromCas).toBe("GH-1900:submit@ready");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.artifact.workUnitId).toBe("GH-1900");
    expect(parsed.artifact.tree.sha).toBe(HEX40);
    expect(parsed.steps.map((s) => s.kind)).toEqual([
      "preflight",
      "keeper-commit",
      "keeper-push",
      "publisher-pr-open",
      "set-ref",
    ]);
    const setRefStep = parsed.steps.find((s) => s.kind === "set-ref");
    expect(setRefStep?.ref).toBe("GH-1900:submit@published");
  });

  test("publish without --from-cas → non-zero exit with hint", async () => {
    const errors: string[] = [];
    const output = {
      log: () => {},
      error: (line: string) => errors.push(line),
    };
    const exit = await runCli(["submit", "publish"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.some((line) => line.includes("--from-cas <ref> is required"))).toBe(true);
  });
});
