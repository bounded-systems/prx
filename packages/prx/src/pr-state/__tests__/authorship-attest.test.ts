import type { KeyObject } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  digestManifest,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
  type Digest,
} from "@bounded-systems/anchored-chain";

import { type AttestDeps } from "../../provenance/attest.ts";
import { slsaProvenanceStatement, verifySlsaEnvelope } from "../../provenance/slsa.ts";
import { AUTHORSHIP_BUILD_TYPE, attestAuthorship } from "../authorship-attest.ts";

const BUILDER_ID = "prx://keeperd/commit";
const NOW = 1000;
const OID = "0123456789abcdef0123456789abcdef01234567";
// sha256 of keeperd's signed L3 envelope (the `l3` input).
const L3 = "a".repeat(64);

type FakeStore = Pick<DerivationStore, "append" | "get"> & {
  readonly appended: Derivation[];
};

/** Map-backed store that records appends, idempotent on derivationId. */
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

/** Deps wired to a fresh ed25519 keypair; returns the public key for asserts. */
function mkDeps(store: FakeStore): { deps: AttestDeps; publicKey: KeyObject } {
  const kp = generateEd25519Keypair();
  return {
    deps: {
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      store,
      builderId: BUILDER_ID,
      now: () => NOW,
    },
    publicKey: kp.publicKey,
  };
}

describe("attestAuthorship", () => {
  test("records a signed authorship/v1 derivation: commit subject, L3 input, verdict params", async () => {
    const store = fakeStore();
    const { deps, publicKey } = mkDeps(store);

    const d = await attestAuthorship(deps, {
      commitSha: OID,
      l3EnvelopeDigest: L3,
      authorship: {
        model: "claude-opus-4-8",
        aiAuthored: ["src/a.ts"],
        divergent: ["src/b.ts"], // bypass
        stale: [],
      },
    });

    expect(store.appended).toHaveLength(1);
    expect(d.manifest.producer).toBe(BUILDER_ID);
    // Subject = the commit; keeper's L3 envelope = a content-addressed input.
    expect(d.manifest.outputs.commit).toBe(`gitCommit:${OID}` as Digest);
    expect(d.manifest.inputs.l3).toBe(`sha256:${L3}` as Digest);
    expect(d.manifest.contracts).toEqual([]);
    // The reconciled verdict rides in params.
    expect(d.manifest.params.aiAuthored).toEqual(["src/a.ts"]);
    expect(d.manifest.params.divergent).toEqual(["src/b.ts"]);
    expect(d.manifest.params.stale).toEqual([]);
    expect(d.manifest.params.model).toBe("claude-opus-4-8");
    // Content-addressed + signed once.
    expect(d.derivationId).toBe(digestManifest(d.manifest));
    expect(d.envelope?.signatures.length).toBe(1);

    const stmt = slsaProvenanceStatement({
      buildType: AUTHORSHIP_BUILD_TYPE,
      builderId: BUILDER_ID,
      subject: [{ name: "commit", digest: { gitCommit: OID } }],
      resolvedDependencies: [{ name: "l3", digest: { sha256: L3 } }],
      externalParameters: {
        model: "claude-opus-4-8",
        aiAuthored: ["src/a.ts"],
        divergent: ["src/b.ts"],
        stale: [],
      },
      invocationId: d.derivationId as string,
      startedOn: new Date(NOW).toISOString(),
    });
    expect(await verifySlsaEnvelope(stmt, d.envelope!, ed25519Verifier(publicKey))).toBe(true);
  });

  test("omits model when the box reported none", async () => {
    const store = fakeStore();
    const { deps } = mkDeps(store);

    const d = await attestAuthorship(deps, {
      commitSha: OID,
      l3EnvelopeDigest: L3,
      authorship: { aiAuthored: ["x.ts"], divergent: [], stale: [] },
    });

    expect("model" in (d.manifest.params as Record<string, unknown>)).toBe(false);
  });

  test("idempotent: re-attesting the same verdict returns the stored derivation, no duplicate append", async () => {
    const store = fakeStore();
    const { deps } = mkDeps(store);
    const input = {
      commitSha: OID,
      l3EnvelopeDigest: L3,
      authorship: { aiAuthored: ["a.ts"], divergent: [], stale: [] },
    };

    const first = await attestAuthorship(deps, input);
    const second = await attestAuthorship(deps, input);

    expect(second.derivationId).toBe(first.derivationId);
    expect(store.appended).toHaveLength(1);
  });
});
