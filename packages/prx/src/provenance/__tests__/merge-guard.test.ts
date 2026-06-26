// GH-2249: the merge-guard provenance projection. Given a head commit, it
// enumerates the ledger's push/v1 derivations attesting it and re-verifies each
// envelope, returning the `provenance` axis the synchronous merge gate reads.
// Fail-closed on a present-but-unverifiable derivation; never blocks when
// enforcement is off or no derivation is present.

import { describe, expect, test } from "bun:test";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
  type Digest,
  type Verifier,
} from "@bounded-systems/anchored-chain";
import type { ProcExecutor, ProcRequest, ProcResult } from "@bounded-systems/proc";

import { attestingProc, GIT_PUSH_BUILD_TYPE, type AttestDeps } from "../attest.ts";
import { projectProvenanceAxis, provenanceEventFor } from "../merge-guard.ts";

const OID = "1234567890abcdef1234567890abcdef12345678";

/** Map-backed store with the reverse index the projection reads. */
type FakeStore = Pick<DerivationStore, "append" | "get" | "derivationsByOutput">;
function fakeStore(): FakeStore {
  const byId = new Map<string, Derivation>();
  const byOutput = new Map<string, Set<string>>();
  return {
    async append(d) {
      byId.set(d.derivationId as string, d);
      for (const digest of Object.values(d.manifest.outputs)) {
        const set = byOutput.get(digest as string) ?? new Set();
        set.add(d.derivationId as string);
        byOutput.set(digest as string, set);
      }
    },
    async get(id) {
      return byId.get(id as string) ?? null;
    },
    async derivationsByOutput(digest) {
      return [...(byOutput.get(digest as string) ?? [])] as Digest[];
    },
  };
}

/** Attest deps on a fresh keypair + the matching verifier. */
function mkAttest(store: FakeStore): { deps: AttestDeps; verifier: Verifier } {
  const kp = generateEd25519Keypair();
  return {
    deps: { signer: ed25519Signer(kp.privateKey, kp.keyid), store, now: () => 1000 },
    verifier: ed25519Verifier(kp.publicKey),
  };
}

const ok: ProcResult = { status: 0, stdout: "", stderr: "", signal: null };
function inner(): ProcExecutor {
  return {
    async exec() {
      return ok;
    },
  };
}

/** Emit a signed push/v1 derivation whose subject is `gitCommit:<oid>`. */
async function emitPush(deps: AttestDeps, oid: string): Promise<void> {
  const exec = attestingProc(inner(), deps, () => ({
    buildType: GIT_PUSH_BUILD_TYPE,
    subject: [{ name: "commit", digest: { gitCommit: oid } }],
  }));
  await exec.exec({ command: "git", args: ["push"] } as ProcRequest);
}

/**
 * prx-6s8: emit a push/v1 that carries `params.subcommand` (so it is a policed
 * effect) and a chosen `producer` builder id (so its owning actor is known).
 * `builderId` of `prx://<actor>/push` resolves to `<actor>` via
 * `actorFromBuilderId`, the identity `verifyEffectOwnership` checks against the
 * policy table.
 */
async function emitPushAs(deps: AttestDeps, oid: string, builderId: string): Promise<void> {
  const exec = attestingProc(inner(), { ...deps, builderId }, () => ({
    buildType: GIT_PUSH_BUILD_TYPE,
    subject: [{ name: "commit", digest: { gitCommit: oid } }],
    externalParameters: { subcommand: "push" },
  }));
  await exec.exec({ command: "git", args: ["push"] } as ProcRequest);
}

describe("projectProvenanceAxis", () => {
  test("enforcement off ⇒ unchecked (even with no derivation)", async () => {
    const store = fakeStore();
    const { verifier } = mkAttest(store);
    expect(await projectProvenanceAxis(OID, { store, verifier, enforce: false })).toBe("unchecked");
  });

  test("a signed derivation under the matching verifier ⇒ verified", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPush(deps, OID);
    expect(await projectProvenanceAxis(OID, { store, verifier, enforce: true })).toBe("verified");
  });

  // GH-352: the uniform freshness check. When isStale + currentRefs are wired, a
  // verified-but-stale derivation fails closed; a fresh one stays verified.
  test("verified but stale (isStale ⇒ true) ⇒ unsigned (fail closed)", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPush(deps, OID);
    expect(
      await projectProvenanceAxis(OID, {
        store,
        verifier,
        enforce: true,
        currentRefs: {},
        isStale: async () => true,
      }),
    ).toBe("unsigned");
  });

  test("verified and fresh (isStale ⇒ false) ⇒ verified", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPush(deps, OID);
    expect(
      await projectProvenanceAxis(OID, {
        store,
        verifier,
        enforce: true,
        currentRefs: {},
        isStale: async () => false,
      }),
    ).toBe("verified");
  });

  // prx-6s8: ownership is enforced alongside the signature. A push owned by its
  // producer stays verified; one produced by a non-owning actor fails closed
  // even though the envelope is authentic.
  test("a signed push owned by its producer (keeper) ⇒ verified", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPushAs(deps, OID, "prx://keeper/push");
    expect(await projectProvenanceAxis(OID, { store, verifier, enforce: true })).toBe("verified");
  });

  test("a signed push produced by a non-owning actor (reviewer) ⇒ unsigned (orphan effect)", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPushAs(deps, OID, "prx://reviewer/push");
    expect(await projectProvenanceAxis(OID, { store, verifier, enforce: true })).toBe("unsigned");
  });

  test("a signed derivation under a wrong-key verifier ⇒ unsigned (fail closed)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    const { verifier: wrong } = mkAttest(fakeStore()); // independent keypair
    await emitPush(deps, OID);
    expect(await projectProvenanceAxis(OID, { store, verifier: wrong, enforce: true })).toBe(
      "unsigned",
    );
  });

  test("no derivation present ⇒ unchecked (gate not tightened to presence)", async () => {
    const store = fakeStore();
    const { verifier } = mkAttest(store);
    expect(await projectProvenanceAxis(OID, { store, verifier, enforce: true })).toBe("unchecked");
  });

  test("a present derivation with no verifier configured ⇒ unsigned (fail closed)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    await emitPush(deps, OID);
    expect(await projectProvenanceAxis(OID, { store, verifier: null, enforce: true })).toBe(
      "unsigned",
    );
  });

  test("only the requested commit's derivations are checked", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    await emitPush(deps, OID);
    const other = "ffffffffffffffffffffffffffffffffffffffff";
    // A different commit has no attestation → unchecked, independent of OID.
    expect(await projectProvenanceAxis(other, { store, verifier, enforce: true })).toBe(
      "unchecked",
    );
  });
});

describe("provenanceEventFor", () => {
  test("maps each axis to its driving event", () => {
    expect(provenanceEventFor("verified")).toEqual({ type: "PROVENANCE_VERIFIED" });
    expect(provenanceEventFor("unsigned")).toEqual({ type: "PROVENANCE_UNSIGNED" });
    expect(provenanceEventFor("unchecked")).toEqual({ type: "PROVENANCE_UNCHECKED" });
  });
});
