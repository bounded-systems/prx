// prx-tth: scope-gate — implement.files_changed ⊆ plan.paths, as a signed
// verdict. These tests ARE the contract: subset → pass; an out-of-scope file →
// a STILL-signed fail naming the violation; empty allowlist → fail-closed; and
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

import type { ImplementArtifact } from "../../src/pipeline/implement-artifact.ts";
import {
  runScopeGate,
  ScopeGateInputError,
  type ScopeGateDeps,
} from "../../src/pr-state/scope-gate.ts";

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

function mkDeps(
  store: FakeStore,
  paths: readonly string[],
  impl: ImplementArtifact | null,
): ScopeGateDeps {
  const kp = generateEd25519Keypair();
  return {
    signer: ed25519Signer(kp.privateKey, kp.keyid),
    store,
    now: () => 1000,
    loadPlanPaths: async () => paths,
    loadImplement: async () => impl,
  };
}

function impl(files: string[]): ImplementArtifact {
  return { unit: "u", commit: COMMIT, summary: "s", files_changed: files };
}

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-scope-gate-cas-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("runScopeGate (prx-tth)", () => {
  test("files_changed ⊆ plan.paths → PASS (signed)", async () => {
    const store = fakeStore();
    const deps = mkDeps(
      store,
      ["packages/prx/src/pr-state/home-update.ts", "packages/prx/src/pr-state/cli.ts"],
      impl(["packages/prx/src/pr-state/home-update.ts", "packages/prx/src/pr-state/cli.ts"]),
    );

    const result = await runScopeGate("u", deps);

    expect(result.pass).toBe(true);
    expect(result.verdict.violations).toEqual([]);
    expect(result.gate).toBe("scope");
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.manifest.params.verdict).toBe("pass");
  });

  test("a file outside the allowlist → FAIL naming the violation (still signed)", async () => {
    const store = fakeStore();
    const deps = mkDeps(
      store,
      ["packages/prx/src/pr-state/cli.ts"],
      impl(["packages/prx/src/pr-state/cli.ts", "packages/prx/src/sneaky/unrelated.ts"]),
    );

    const result = await runScopeGate("u", deps);

    expect(result.pass).toBe(false);
    expect(result.verdict.violations).toEqual(["packages/prx/src/sneaky/unrelated.ts"]);
    // A failed gate is signed evidence too.
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.manifest.params.verdict).toBe("fail");
  });

  test("empty plan.paths → fail-closed (signed fail, not pass)", async () => {
    const store = fakeStore();
    const deps = mkDeps(store, [], impl(["packages/prx/src/anything.ts"]));

    const result = await runScopeGate("u", deps);

    expect(result.pass).toBe(false);
    expect(result.verdict.reason).toContain("no path allowlist");
    expect(store.appended).toHaveLength(1);
  });

  test("no implement artifact → ScopeGateInputError (nothing to gate)", async () => {
    const store = fakeStore();
    const deps = mkDeps(store, ["x"], null);

    await expect(runScopeGate("u", deps)).rejects.toBeInstanceOf(ScopeGateInputError);
    expect(store.appended).toHaveLength(0);
  });
});
