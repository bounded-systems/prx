// GH-352: the local CI provenance projection — the merge-guard verdict for HEAD
// PLUS a freshness signal (does the recorded green still cover the current
// tree?). This is where `isStale` is meaningful (the merge-guard's is a no-op
// because it gates a commit, which pins the tree).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
} from "@bounded-systems/anchored-chain";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";

import { type AttestDeps } from "../../src/provenance/attest.ts";
import { attestCiPhases, currentCiRefs, resolveCiInputs } from "../../src/pr-state/ci-attest.ts";
import { resolveCiProvenanceState } from "../../src/pr-state/ci-provenance-state.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const INPUTS = resolveCiInputs({ treeOid: "abc123", lock: "lock-bytes", toolchain: "bun 1.3.11" });

let dir: string;
let chain: ReturnType<typeof openAnchoredChain>;
let kp: ReturnType<typeof generateEd25519Keypair>;
let attest: AttestDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-prov-state-"));
  chain = openAnchoredChain(join(dir, "ledger.sqlite"));
  kp = generateEd25519Keypair();
  attest = {
    signer: ed25519Signer(kp.privateKey, kp.keyid),
    store: chain.derivations,
    now: () => 1000,
  };
});

afterEach(() => {
  chain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveCiProvenanceState — verdict + freshness (GH-352)", () => {
  test("verified + fresh when the signed derivation covers the current tree", async () => {
    await attestCiPhases(attest, INPUTS, COMMIT, ["typecheck", "test"]);
    const state = await resolveCiProvenanceState({
      store: chain,
      commit: COMMIT,
      currentRefs: currentCiRefs(INPUTS),
      verifier: ed25519Verifier(kp.publicKey),
    });
    expect(state).toEqual({ verdict: "verified", freshness: "fresh" });
  });

  test("stale once the current tree no longer matches what CI validated", async () => {
    await attestCiPhases(attest, INPUTS, COMMIT, ["test"]);
    const movedTree = resolveCiInputs({
      treeOid: "def456",
      lock: "lock-bytes",
      toolchain: "bun 1.3.11",
    });
    const state = await resolveCiProvenanceState({
      store: chain,
      commit: COMMIT,
      currentRefs: currentCiRefs(movedTree),
      verifier: ed25519Verifier(kp.publicKey),
    });
    expect(state.verdict).toBe("verified");
    expect(state.freshness).toBe("stale");
  });

  test("unchecked + unknown when no derivation attests the commit", async () => {
    const state = await resolveCiProvenanceState({
      store: chain,
      commit: "f".repeat(40),
      currentRefs: currentCiRefs(INPUTS),
      verifier: ed25519Verifier(kp.publicKey),
    });
    expect(state).toEqual({ verdict: "unchecked", freshness: "unknown" });
  });

  test("unsigned when present derivations cannot be verified (wrong key)", async () => {
    await attestCiPhases(attest, INPUTS, COMMIT, ["test"]);
    const wrong = generateEd25519Keypair();
    const state = await resolveCiProvenanceState({
      store: chain,
      commit: COMMIT,
      currentRefs: currentCiRefs(INPUTS),
      verifier: ed25519Verifier(wrong.publicKey),
    });
    expect(state.verdict).toBe("unsigned");
  });
});
