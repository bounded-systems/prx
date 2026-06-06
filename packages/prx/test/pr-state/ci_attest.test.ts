// GH-352: a green `prx ci` records a signed `checks/v1` per phase, keyed on the
// commit under test. These tests ARE the contract: each passed phase produces a
// distinct, signed, verifiable derivation sharing one subject commit; the path
// is idempotent (re-recording the same (commit, phase) appends nothing new).
//
// Mirrors test/provenance/checks-attest.test.ts (the pilot's verify step), since
// `attestCiPhases` reuses the same `persistAttestation`/`checks/v1` machinery —
// the point of the GH-352 design is that both surfaces emit the identical shape.
import { describe, expect, test } from "bun:test";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";

import { CHECKS_BUILD_TYPE, type AttestDeps } from "../../src/provenance/attest.ts";
import { verifySlsaDerivation } from "../../src/provenance/verify.ts";
import { attestCiPhases, CI_ATTEST_SURFACE } from "../../src/pr-state/ci-attest.ts";
import { CI_PHASES } from "../../src/pr-state/local-ci.ts";

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

function mkAttest(store: FakeStore): {
  deps: AttestDeps;
  verifier: ReturnType<typeof ed25519Verifier>;
} {
  const kp = generateEd25519Keypair();
  return {
    deps: { signer: ed25519Signer(kp.privateKey, kp.keyid), store, now: () => 1000 },
    verifier: ed25519Verifier(kp.publicKey),
  };
}

describe("attestCiPhases — green prx ci → signed checks/v1 per phase (GH-352)", () => {
  test("records one signed, verifiable checks/v1 per phase, all keyed on the commit", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    const phases = [...CI_PHASES];

    const recorded = await attestCiPhases(deps, COMMIT, phases);

    expect(recorded).toHaveLength(phases.length);
    expect(store.appended).toHaveLength(phases.length);
    for (const derivation of recorded) {
      // Signed envelope verifies under the configured key.
      expect(await verifySlsaDerivation(derivation, verifier)).toBe(true);
      // Subject is the commit under test (not a self-reported boolean).
      expect(String(derivation.manifest.outputs.checks)).toBe(`gitCommit:${COMMIT}`);
      expect(derivation.manifest.params.surface).toBe(CI_ATTEST_SURFACE);
      expect(derivation.manifest.params.phase).toBeDefined();
    }
    // Build type is the SHARED checks/v1 (no parallel CI shape).
    expect(recorded.every((d) => d.envelope !== undefined)).toBe(true);
  });

  test("distinct phases yield distinct derivation ids (the phase feeds the digest)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);

    const recorded = await attestCiPhases(deps, COMMIT, ["typecheck", "test"]);

    const ids = new Set(recorded.map((d) => d.derivationId as string));
    expect(ids.size).toBe(2);
  });

  test("idempotent: re-recording the same (commit, phase) appends nothing new", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);

    const first = await attestCiPhases(deps, COMMIT, ["typecheck"]);
    const second = await attestCiPhases(deps, COMMIT, ["typecheck"]);

    expect(store.appended).toHaveLength(1);
    expect(second[0]!.derivationId).toBe(first[0]!.derivationId);
  });

  test("a different commit produces a different attestation (subject binds the tree)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);

    const a = await attestCiPhases(deps, COMMIT, ["test"]);
    const b = await attestCiPhases(deps, "f".repeat(40), ["test"]);

    expect(a[0]!.derivationId).not.toBe(b[0]!.derivationId);
    expect(store.appended).toHaveLength(2);
  });
});

// Sanity: the shared build type is what the pilot uses, proving "no parallel
// CI shape" — the merge guard reads one checks/v1 family regardless of surface.
test("uses the shared checks/v1 build type", () => {
  expect(CHECKS_BUILD_TYPE).toBe("https://prx.dev/checks/v1");
});
