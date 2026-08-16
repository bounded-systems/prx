// The launch keygen core must produce keys the verifier accepts: ed25519, the
// private signs what the public (PRX_LAUNCH_PUBKEY, via createPublicKey) verifies.
import { describe, test, expect } from "bun:test";
import { sign, verify, createPrivateKey, createPublicKey } from "node:crypto";

import { generateLaunchKeypair } from "../../scripts/keeperd/launch-keygen.ts";

describe("generateLaunchKeypair", () => {
  test("generates an ed25519 keypair that signs + verifies (PEM, verifier-compatible)", () => {
    const { privatePem, publicPem } = generateLaunchKeypair();
    expect(privatePem).toContain("BEGIN PRIVATE KEY");
    expect(publicPem).toContain("BEGIN PUBLIC KEY");

    const data = Buffer.from("L2 launch attestation");
    const signature = sign(null, data, createPrivateKey(privatePem));
    expect(verify(null, data, createPublicKey(publicPem), signature)).toBe(true);
  });

  test("each call yields a distinct key", () => {
    expect(generateLaunchKeypair().publicPem).not.toBe(generateLaunchKeypair().publicPem);
  });
});
