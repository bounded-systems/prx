// GH-2269: the SLSA-aware live verifier (verify.ts) and the D3 envelope
// mismatch it exists to resolve. A SLSA envelope is exactly what the core
// `validateDerivation` rejects (it binds against the bespoke manifest
// statement); the SLSA verifier accepts the same envelope.

import { describe, expect, test } from "bun:test";

import {
  digestManifest,
  ed25519Verifier,
  generateEd25519Keypair,
  ed25519Signer,
  validateDerivation,
  type ContractRegistry,
  type Derivation,
  type DerivationStore,
  type Digest,
} from "@bounded-systems/anchored-chain";

import { signSlsaStatement, slsaProvenanceStatement } from "../slsa.ts";
import {
  decodeSlsaStatement,
  verifySlsaDerivation,
  verifySlsaDerivationEnvelope,
} from "../verify.ts";

const BUILDER_ID = "prx://claude-code/submit";
const PUSH_BUILD_TYPE = "https://prx.dev/git/push/v1";
const OID = "0123456789abcdef0123456789abcdef01234567";

/** Build a Derivation carrying a signed SLSA envelope (as attest.ts emits). */
async function slsaDerivation(signer: Parameters<typeof signSlsaStatement>[1]) {
  const manifest: Derivation["manifest"] = {
    producer: BUILDER_ID,
    inputs: {},
    outputs: { commit: `gitCommit:${OID}` as Digest },
    contracts: [],
    params: {},
  };
  const derivationId = digestManifest(manifest);
  const statement = slsaProvenanceStatement({
    buildType: PUSH_BUILD_TYPE,
    builderId: BUILDER_ID,
    subject: [{ name: "commit", digest: { gitCommit: OID } }],
    invocationId: derivationId as string,
    startedOn: new Date(1000).toISOString(),
  });
  const envelope = await signSlsaStatement(statement, signer);
  const derivation: Derivation = { derivationId, manifest, envelope, ts: 1000 };
  return derivation;
}

/** A registry with no contract validators (the manifest carries `contracts: []`). */
const emptyRegistry: ContractRegistry = {
  getValidator: () => () => ({ ok: true }),
};

function singletonStore(d: Derivation): Pick<DerivationStore, "get"> {
  return { async get(id) { return id === d.derivationId ? d : null; } };
}

describe("verify.ts — SLSA-aware live verifier", () => {
  test("core validateDerivation REJECTS a SLSA envelope (the D3 mismatch)", async () => {
    const kp = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));

    const verdict = await validateDerivation(
      d.derivationId,
      singletonStore(d),
      emptyRegistry,
      { verifier: ed25519Verifier(kp.publicKey), requireSigned: true },
    );
    expect(verdict.ok).toBe(false);
    // The signed payload is the SLSA Statement, not manifestToStatement(manifest).
    if (!verdict.ok) {
      expect(verdict.contract as string).toBe("anchored-chain/envelope-mismatch");
    }
  });

  test("verifySlsaDerivation ACCEPTS the same SLSA envelope", async () => {
    const kp = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    expect(await verifySlsaDerivation(d, ed25519Verifier(kp.publicKey))).toBe(true);
  });

  test("a wrong key fails closed", async () => {
    const kp = generateEd25519Keypair();
    const other = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    expect(await verifySlsaDerivation(d, ed25519Verifier(other.publicKey))).toBe(false);
  });

  test("an unsigned derivation (no envelope) fails closed", async () => {
    const kp = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    const unsigned: Pick<Derivation, "envelope"> = {};
    expect(
      await verifySlsaDerivation(unsigned, ed25519Verifier(kp.publicKey)),
    ).toBe(false);
  });

  test("decodeSlsaStatement round-trips the signed Statement", async () => {
    const kp = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    const stmt = decodeSlsaStatement(d.envelope!);
    expect(stmt.predicate.buildDefinition.buildType).toBe(PUSH_BUILD_TYPE);
    expect(stmt.subject[0]!.digest.gitCommit).toBe(OID);
  });

  test("a malformed (non-JSON) payload fails closed without throwing", async () => {
    const kp = generateEd25519Keypair();
    const d = await slsaDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    const corrupt = {
      ...d.envelope!,
      payload: Buffer.from("not json", "utf8").toString("base64"),
    };
    expect(
      await verifySlsaDerivationEnvelope(corrupt, ed25519Verifier(kp.publicKey)),
    ).toBe(false);
  });
});
