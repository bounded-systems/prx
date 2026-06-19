// GH-2249: ed25519 key-import helpers. A key minted in one run must round-trip
// through a base64 env var into a verifying run, so enforcement (`requireSigned`)
// can check a signature across processes. Both accepted encodings — a raw
// 32-byte seed/point and full PKCS8/SPKI DER — must reconstruct the same key.

import { describe, expect, test } from "bun:test";

import {
  dssePae,
  DSSE_PAYLOAD_TYPE,
  ed25519Keyid,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  importEd25519PrivateKey,
  importEd25519PublicKey,
} from "../index.ts";

const PAE = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("payload"));

/** Raw 32-byte ed25519 seed (private `d`) as standard base64. */
function rawSeedB64(privateKey: ReturnType<typeof generateEd25519Keypair>["privateKey"]): string {
  const jwk = privateKey.export({ format: "jwk" }) as { d: string };
  return Buffer.from(jwk.d, "base64url").toString("base64");
}

/** Raw 32-byte ed25519 public point (`x`) as standard base64. */
function rawPointB64(publicKey: ReturnType<typeof generateEd25519Keypair>["publicKey"]): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

describe("ed25519 key-import — raw seed/point encoding", () => {
  test("a raw-seed signer + raw-point verifier round-trip", async () => {
    const kp = generateEd25519Keypair();
    const priv = importEd25519PrivateKey(rawSeedB64(kp.privateKey));
    const pub = importEd25519PublicKey(rawPointB64(kp.publicKey));

    // The imported pair must agree on the keyid the emitter and verifier share.
    expect(ed25519Keyid(pub)).toBe(kp.keyid);

    const sig = await ed25519Signer(priv, ed25519Keyid(pub)).sign(PAE);
    expect(await ed25519Verifier(pub).verify(PAE, sig)).toBe(true);
  });
});

describe("ed25519 key-import — full DER encoding", () => {
  test("a PKCS8 signer + SPKI verifier round-trip", async () => {
    const kp = generateEd25519Keypair();
    const pkcs8 = (kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString(
      "base64",
    );
    const spki = (kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
      "base64",
    );

    const priv = importEd25519PrivateKey(pkcs8);
    const pub = importEd25519PublicKey(spki);

    const sig = await ed25519Signer(priv, kp.keyid).sign(PAE);
    expect(await ed25519Verifier(pub).verify(PAE, sig)).toBe(true);
  });
});

describe("ed25519 key-import — cross-encoding equivalence", () => {
  test("raw-seed and PKCS8 imports produce the same signing key", async () => {
    const kp = generateEd25519Keypair();
    const fromRaw = importEd25519PrivateKey(rawSeedB64(kp.privateKey));
    const fromDer = importEd25519PrivateKey(
      (kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
    );
    const pub = importEd25519PublicKey(rawPointB64(kp.publicKey));

    const sigRaw = await ed25519Signer(fromRaw, kp.keyid).sign(PAE);
    const sigDer = await ed25519Signer(fromDer, kp.keyid).sign(PAE);
    // ed25519 is deterministic: the same key over the same PAE yields one signature.
    expect(sigRaw.sig).toBe(sigDer.sig);
    expect(await ed25519Verifier(pub).verify(PAE, sigRaw)).toBe(true);
  });

  test("a mismatched public key rejects the signature", async () => {
    const kp = generateEd25519Keypair();
    const other = generateEd25519Keypair();
    const priv = importEd25519PrivateKey(rawSeedB64(kp.privateKey));
    const wrongPub = importEd25519PublicKey(rawPointB64(other.publicKey));

    const sig = await ed25519Signer(priv, kp.keyid).sign(PAE);
    expect(await ed25519Verifier(wrongPub).verify(PAE, sig)).toBe(false);
  });
});
