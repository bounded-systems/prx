// prx-tth: the Gate framework — runGate emits a signed gate/v1 attestation
// (pass OR fail) plus a typed CAS verdict artifact. These tests ARE the
// contract: a verdict is always signed and verifiable, the CAS artifact
// round-trips, and a fail carries its violations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";

import type { AttestDeps } from "../../src/provenance/attest.ts";
import {
  GATE_BUILD_TYPE,
  gateVerdictEdge,
  runGate,
} from "../../src/provenance/gate.ts";
import { verifySlsaDerivation } from "../../src/provenance/verify.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

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

function mkDeps(store: FakeStore): {
  deps: AttestDeps;
  verifier: ReturnType<typeof ed25519Verifier>;
} {
  const kp = generateEd25519Keypair();
  return {
    deps: { signer: ed25519Signer(kp.privateKey, kp.keyid), store, now: () => 1000 },
    verifier: ed25519Verifier(kp.publicKey),
  };
}

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-gate-cas-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("runGate — signed gate/v1 verdict + CAS artifact (prx-tth)", () => {
  test("GATE_BUILD_TYPE is the gate/v1 predicate type", () => {
    expect(GATE_BUILD_TYPE).toBe("https://prx.dev/gate/v1");
  });

  test("a PASS verdict signs a gate/v1 derivation and pins the verdict artifact", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkDeps(store);

    const result = await runGate(
      { unit: "u-pass", gate: "scope", subjectCommit: COMMIT, pass: true, violations: [] },
      deps,
    );

    expect(result.pass).toBe(true);
    // Exactly one signed derivation, verifiable under the configured key.
    expect(store.appended).toHaveLength(1);
    const derivation = store.appended[0]!;
    expect(await verifySlsaDerivation(derivation, verifier)).toBe(true);
    // Subject is the gated commit; verdict lives in the params.
    expect(String(derivation.manifest.outputs.scope)).toBe(`gitCommit:${COMMIT}`);
    expect(derivation.manifest.params.verdict).toBe("pass");
    expect(derivation.manifest.params.gate).toBe("scope");
    // The derivationId is reported back and matches the CAS artifact's link.
    expect(result.derivationId).toBe(String(derivation.derivationId));

    // The CAS verdict artifact round-trips at <unit>:gate@scope.
    const consumed = await consumeArtifact(gateVerdictEdge("scope"), "u-pass");
    expect(consumed.missing).toBeUndefined();
    expect(consumed.value).toMatchObject({
      unit: "u-pass",
      gate: "scope",
      pass: true,
      violations: [],
      subject: COMMIT,
      attestation: result.derivationId,
    });
  });

  test("a FAIL verdict is STILL signed and carries its violations", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkDeps(store);

    const result = await runGate(
      {
        unit: "u-fail",
        gate: "scope",
        subjectCommit: COMMIT,
        pass: false,
        violations: ["src/rogue.ts", "src/other.ts"],
        reason: "2 file(s) outside declared scope",
      },
      deps,
    );

    expect(result.pass).toBe(false);
    // Crucially: a failed gate is signed evidence too (not absence).
    expect(store.appended).toHaveLength(1);
    expect(await verifySlsaDerivation(store.appended[0]!, verifier)).toBe(true);
    expect(store.appended[0]!.manifest.params.verdict).toBe("fail");

    const consumed = await consumeArtifact(gateVerdictEdge("scope"), "u-fail");
    expect(consumed.value).toMatchObject({
      pass: false,
      violations: ["src/rogue.ts", "src/other.ts"],
      reason: "2 file(s) outside declared scope",
    });
  });

  test("re-running an identical verdict is idempotent in the ledger", async () => {
    const store = fakeStore();
    const { deps } = mkDeps(store);
    const input = {
      unit: "u-idem",
      gate: "scope",
      subjectCommit: COMMIT,
      pass: true,
      violations: [] as string[],
    };
    await runGate(input, deps);
    await runGate(input, deps);
    expect(store.appended).toHaveLength(1);
  });
});
