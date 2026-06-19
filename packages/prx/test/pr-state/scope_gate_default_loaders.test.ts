// prx-tth — scope-gate's *default* loaders (the CAS-backed plan/implement reads
// the existing scope-gate.test.ts injects past). Drives runScopeGate without
// loadPlanPaths/loadImplement against a seeded temp CAS so every default arm
// runs: implement present/absent, and the plan-paths parse ladder (no plan /
// markdown / bad-json / not-a-plan / valid-with-paths).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";

import { emitArtifact } from "../../src/pipeline/edge.ts";
import {
  implementArtifactEdge,
  type ImplementArtifact,
} from "../../src/pipeline/implement-artifact.ts";
import { runPlanSave } from "../../src/plan-store/verbs.ts";
import {
  runScopeGate,
  ScopeGateInputError,
  type ScopeGateDeps,
} from "../../src/pr-state/scope-gate.ts";

const COMMIT = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

let prevCas: string | undefined;
let casRoot: string;
beforeAll(() => {
  prevCas = process.env.PRX_CAS_ROOT;
  casRoot = mkdtempSync(join(tmpdir(), "prx-scope-cas-"));
  process.env.PRX_CAS_ROOT = casRoot;
});
afterAll(() => {
  if (prevCas === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevCas;
  rmSync(casRoot, { recursive: true, force: true });
});

function deps(): ScopeGateDeps {
  const kp = generateEd25519Keypair();
  const map = new Map<string, Derivation>();
  const store: Pick<DerivationStore, "append" | "get"> = {
    async append(d) {
      map.set(d.derivationId as string, d);
    },
    async get(id) {
      return map.get(id as string) ?? null;
    },
  };
  // No loadPlanPaths / loadImplement → the production CAS defaults run.
  return {
    signer: ed25519Signer(kp.privateKey, kp.keyid),
    store: store as DerivationStore,
    now: () => 1000,
  };
}

const seedImplement = (unit: string, files: string[]) =>
  emitArtifact(implementArtifactEdge, unit, {
    unit,
    commit: COMMIT,
    summary: "s",
    files_changed: files,
  } as ImplementArtifact);
const seedPlan = (unit: string, body: string) =>
  runPlanSave({ unit, slot: "approved", content: body, skipValidate: true });

const validPlan = (paths: string[]) =>
  JSON.stringify({ problem: "p", scope: "s", approach: "a", acceptance: ["ac"], paths });

describe("scope-gate default loaders (seeded CAS)", () => {
  test("no implement artifact → ScopeGateInputError (defaultLoadImplement → null)", async () => {
    await expect(runScopeGate("u-no-impl", deps())).rejects.toBeInstanceOf(ScopeGateInputError);
  });

  test("implement + a JSON plan declaring paths → pass when files ⊆ paths", async () => {
    await seedImplement("u-ok", ["src/a.ts"]);
    await seedPlan("u-ok", validPlan(["src/a.ts", "src/b.ts"]));
    const r = await runScopeGate("u-ok", deps());
    expect(r.pass).toBe(true);
  });

  test("implement + a JSON plan with paths but a file outside → signed fail", async () => {
    await seedImplement("u-violate", ["src/evil.ts"]);
    await seedPlan("u-violate", validPlan(["src/a.ts"]));
    const r = await runScopeGate("u-violate", deps());
    expect(r.pass).toBe(false);
  });

  test("implement but NO plan → empty allowlist (fail-closed)", async () => {
    await seedImplement("u-no-plan", ["src/a.ts"]);
    const r = await runScopeGate("u-no-plan", deps());
    expect(r.pass).toBe(false); // runPlanLoad throws → []
  });

  test("implement + a markdown plan → no machine-checkable scope (fail-closed)", async () => {
    await seedImplement("u-md", ["src/a.ts"]);
    await seedPlan("u-md", "## Scope\n\n- src/a.ts\n");
    const r = await runScopeGate("u-md", deps());
    expect(r.pass).toBe(false); // detectPlanBodyFormat → markdown → []
  });

  test("implement + a JSON-shaped but malformed body → fail-closed", async () => {
    await seedImplement("u-badjson", ["src/a.ts"]);
    await seedPlan("u-badjson", "{ not valid json");
    const r = await runScopeGate("u-badjson", deps());
    expect(r.pass).toBe(false); // JSON.parse throws → []
  });

  test("implement + valid JSON that is not a PlanArtifact → fail-closed", async () => {
    await seedImplement("u-notplan", ["src/a.ts"]);
    await seedPlan("u-notplan", JSON.stringify({ unrelated: true }));
    const r = await runScopeGate("u-notplan", deps());
    expect(r.pass).toBe(false); // PlanArtifactSchema.safeParse fails → []
  });
});
