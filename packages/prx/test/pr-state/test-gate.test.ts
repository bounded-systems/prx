// prx-x8ji: test-gate — run the canonical checks the executor skipped, as a
// signed gate/v1 verdict. These tests ARE the contract: all steps pass → a
// signed PASS; any step fails → a STILL-signed FAIL naming the failed steps;
// no implement artifact → an input error (nothing to gate).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";
import type { ProcExecutor, ProcRequest } from "@bounded-systems/proc";

import type { ImplementArtifact } from "../../src/pipeline/implement-artifact.ts";
import {
  DEFAULT_TEST_GATE_STEPS,
  runTestGate,
  TestGateInputError,
  type TestGateDeps,
} from "../../src/pr-state/test-gate.ts";

const COMMIT = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

type FakeStore = Pick<DerivationStore, "append" | "get"> & {
  readonly appended: Derivation[];
};
function fakeStore(): FakeStore {
  const map = new Map<string, Derivation>();
  const appended: Derivation[] = [];
  return {
    appended,
    async append(d) {
      map.set(d.derivationId as string, d);
      appended.push(d);
    },
    async get(id) {
      return map.get(id as string) ?? null;
    },
  };
}

/** A ProcExecutor that returns queued statuses in order and records requests. */
function recordingExec(statuses: number[]): {
  exec: ProcExecutor;
  seen: ProcRequest[];
} {
  const seen: ProcRequest[] = [];
  let i = 0;
  return {
    seen,
    exec: {
      async exec(req: ProcRequest) {
        seen.push(req);
        return { status: statuses[i++] ?? 0, stdout: "", stderr: "", signal: null };
      },
    },
  };
}

function impl(): ImplementArtifact {
  return { unit: "u", commit: COMMIT, summary: "s", files_changed: ["a.ts"] };
}

function mkDeps(
  store: FakeStore,
  exec: ProcExecutor,
  implArtifact: ImplementArtifact | null,
): TestGateDeps {
  const kp = generateEd25519Keypair();
  return {
    signer: ed25519Signer(kp.privateKey, kp.keyid),
    store,
    now: () => 1000,
    runCheck: exec,
    loadImplement: async () => implArtifact,
  };
}

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-test-gate-cas-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("runTestGate (prx-x8ji)", () => {
  test("all steps pass → PASS (signed), runs every default step in cwd", async () => {
    const store = fakeStore();
    const { exec, seen } = recordingExec([0, 0]);
    const result = await runTestGate("u", "/repo", mkDeps(store, exec, impl()));

    expect(result.pass).toBe(true);
    expect(result.gate).toBe("test");
    expect(result.verdict.violations).toEqual([]);
    expect(seen).toHaveLength(DEFAULT_TEST_GATE_STEPS.length);
    expect(seen.every((r) => r.cwd === "/repo")).toBe(true);
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.manifest.params.verdict).toBe("pass");
  });

  test("a failing step → FAIL naming the step (still signed); all steps run", async () => {
    const store = fakeStore();
    const { exec, seen } = recordingExec([0, 1]); // bun test fails
    const result = await runTestGate("u", "/repo", mkDeps(store, exec, impl()));

    expect(result.pass).toBe(false);
    expect(result.verdict.violations).toEqual(["bun test (exit 1)"]);
    // No early stop: both steps ran so the verdict is complete.
    expect(seen).toHaveLength(2);
    // A failed gate is signed evidence too.
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.manifest.params.verdict).toBe("fail");
  });

  test("multiple failures are all listed", async () => {
    const store = fakeStore();
    const { exec } = recordingExec([2, 1]);
    const result = await runTestGate("u", "/repo", mkDeps(store, exec, impl()));

    expect(result.pass).toBe(false);
    expect(result.verdict.violations).toEqual(["bun run typecheck (exit 2)", "bun test (exit 1)"]);
  });

  test("no implement artifact → TestGateInputError (nothing to gate)", async () => {
    const store = fakeStore();
    const { exec } = recordingExec([0, 0]);
    await expect(runTestGate("u", "/repo", mkDeps(store, exec, null))).rejects.toBeInstanceOf(
      TestGateInputError,
    );
    expect(store.appended).toHaveLength(0);
  });
});
