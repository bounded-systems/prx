// Checks for the door-keeper L3 verify primitive (Phase B.2): a valid L3 (ed25519
// over the statement JSON, matching subject) verifies; tampered statement,
// wrong subject, wrong key, and malformed input all fail closed.
import { describe, test, expect } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import {
  canonicalJson,
  isL3Attestation,
  verifyL3Attestation,
  type L3Attestation,
} from "../../src/provenance/verify-l3.ts";

function makeL3(commitSha: string, privateKey: KeyObject): L3Attestation {
  // Same shape door-keeper signs: an SLSA statement whose subject is the commit.
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: commitSha, digest: { gitCommit: commitSha } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { buildType: "https://prx.dev/git/push/v1" } },
  };
  const signature = sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString("base64");
  return { statement, signature, keyId: "test-key" };
}

describe("verifyL3Attestation", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const commit = "a".repeat(40);

  test("accepts a valid L3 with the matching subject", () => {
    expect(verifyL3Attestation(makeL3(commit, privateKey), pubPem, commit)).toBe(true);
  });

  test("rejects a tampered statement", () => {
    const att = makeL3(commit, privateKey);
    (att.statement as Record<string, unknown>).injected = "tamper";
    expect(verifyL3Attestation(att, pubPem, commit)).toBe(false);
  });

  test("rejects when the subject is not the expected commit", () => {
    expect(verifyL3Attestation(makeL3(commit, privateKey), pubPem, "b".repeat(40))).toBe(false);
  });

  test("rejects under a different public key", () => {
    const otherPem = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(verifyL3Attestation(makeL3(commit, privateKey), otherPem, commit)).toBe(false);
  });

  test("fails closed on malformed input", () => {
    expect(verifyL3Attestation(null, pubPem)).toBe(false);
    expect(verifyL3Attestation({ signature: "x" }, pubPem)).toBe(false);
    expect(verifyL3Attestation({ statement: {}, signature: "not-base64-sig" }, pubPem, commit)).toBe(false);
  });

  test("isL3Attestation recognises the shape", () => {
    expect(isL3Attestation({ statement: {}, signature: "x" })).toBe(true);
    expect(isL3Attestation({ statement: {} })).toBe(false);
    expect(isL3Attestation(null)).toBe(false);
  });
});
