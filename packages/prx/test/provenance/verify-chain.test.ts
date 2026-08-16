// Checks for the L3 write → L2 launch chain verifier. Builds a real chain via
// ocap-provenance's statement/toSLSA + node:crypto, mirroring door-keeper's
// signer-door output (canonicalJson signing, content-addressed launch link).
import { describe, test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";

import { statement } from "@bounded-systems/ocap-provenance";
import { toSLSA } from "@bounded-systems/ocap-provenance/slsa";
import { canonicalJson } from "@bounded-systems/ocap-provenance/attestation";

import { verifyLaunchChain } from "../../src/provenance/verify-chain.ts";
import type { L3Attestation } from "../../src/provenance/verify-l3.ts";

const COMMIT = "a".repeat(40);
const pem = (k: KeyObject): string => k.export({ type: "spki", format: "pem" }) as string;
const signWith =
  (priv: KeyObject) =>
  (s: string): string =>
    edSign(null, Buffer.from(s), priv).toString("base64");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function buildL2(launcherPriv: KeyObject, manifestDigest: string) {
  const slsa = toSLSA(
    statement([{ name: "box-1", digest: { sha256: manifestDigest } }], {
      level: "launch",
      producer: { kind: "nix-flake", id: "launcher" },
      capabilities: { workcell: "claude-box", manifestDigest: { sha256: manifestDigest } },
    }),
  );
  return {
    statement: slsa,
    signature: signWith(launcherPriv)(canonicalJson(slsa)),
    keyId: "launcher",
  };
}

function buildL3(keeperPriv: KeyObject, l2LaunchDigest: string): L3Attestation {
  const slsa = toSLSA(
    statement([{ name: COMMIT, digest: { gitCommit: COMMIT } }], {
      level: "write",
      producer: { kind: "keeperd", id: "keeper" },
      capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
      links: [{ level: "launch", digest: { sha256: l2LaunchDigest } }],
    }),
  );
  return { statement: slsa, signature: signWith(keeperPriv)(canonicalJson(slsa)), keyId: "keeper" };
}

describe("verifyLaunchChain", () => {
  const keeper = generateKeyPairSync("ed25519");
  const launcher = generateKeyPairSync("ed25519");
  const l2 = buildL2(launcher.privateKey, "e".repeat(64));
  const l2Digest = sha256(canonicalJson(l2.statement));
  const l3 = buildL3(keeper.privateKey, l2Digest);
  const base = {
    keeperKeyPem: pem(keeper.publicKey),
    launcherKeyPem: pem(launcher.publicKey),
    expectedCommit: COMMIT,
  };

  test("accepts a valid L3→L2 chain", () => {
    expect(verifyLaunchChain({ l3, l2, ...base })).toBe(true);
  });

  test("rejects when the L3 links a DIFFERENT L2 (content-address mismatch)", () => {
    const otherL2 = buildL2(launcher.privateKey, "f".repeat(64)); // different manifest → different digest
    expect(verifyLaunchChain({ l3, l2: otherL2, ...base })).toBe(false);
  });

  test("rejects under the wrong launcher key", () => {
    const wrong = pem(generateKeyPairSync("ed25519").publicKey);
    expect(verifyLaunchChain({ l3, l2, ...base, launcherKeyPem: wrong })).toBe(false);
  });

  test("rejects when the L3 attests the wrong commit", () => {
    expect(verifyLaunchChain({ l3, l2, ...base, expectedCommit: "b".repeat(40) })).toBe(false);
  });

  test("rejects an L3 with no launch link", () => {
    const noLink = buildL3(keeper.privateKey, l2Digest);
    // strip the link by re-signing a linkless statement
    const slsa = toSLSA(
      statement([{ name: COMMIT, digest: { gitCommit: COMMIT } }], {
        level: "write",
        producer: { kind: "keeperd", id: "keeper" },
        capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
      }),
    );
    const linkless: L3Attestation = {
      statement: slsa,
      signature: signWith(keeper.privateKey)(canonicalJson(slsa)),
      keyId: "keeper",
    };
    void noLink;
    expect(verifyLaunchChain({ l3: linkless, l2, ...base })).toBe(false);
  });
});
