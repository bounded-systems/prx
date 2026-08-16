/**
 * Verify the **L3 write → L2 launch chain** (Phase B / capability chain): a keeper
 * git-write (L3) must link back to a signed launch attestation (L2) for the box
 * that produced it, so `manifestDigest` enforcement rests on a real, signed launch
 * — not the host's claim. The two attestations are content-addressed and linked by
 * digest (in-toto DAG); each is signed by its own guest's key (keeper / launcher).
 *
 * This is the verifier side. The producer side (the launch flow calling
 * `attest-launch`, the L3 carrying the launch link, and distributing the L2 so it
 * can be fetched) is the remaining integration; `verifyLaunchChain` is what the
 * merge gate calls once it has both attestations.
 */

import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";

import { verifyAttestation, canonicalJson } from "@bounded-systems/ocap-provenance/attestation";
import { fromSLSA, type SLSAStatement } from "@bounded-systems/ocap-provenance/slsa";

import { verifyL3Attestation, type L3Attestation } from "./verify-l3.ts";

/** A signed L2 launch attestation (statement + detached signature). */
export type LaunchAttestation = { statement: unknown; signature: string; keyId?: string };

function ed25519VerifierFor(publicKeyPem: string) {
  return (data: string, signatureBase64: string): boolean => {
    try {
      return ed25519Verify(
        null,
        Buffer.from(data),
        createPublicKey(publicKeyPem),
        Buffer.from(signatureBase64, "base64"),
      );
    } catch {
      return false;
    }
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Verify the L3→L2 chain, fail closed. True iff:
 *  1. the L3 verifies under `keeperKeyPem` and attests `expectedCommit`,
 *  2. the L2 verifies under `launcherKeyPem`,
 *  3. the L2 is a `level:"launch"` statement and the L3 a `level:"write"`, and
 *  4. the L3 links back to EXACTLY this L2 by content-address.
 *
 * (Manifest-grants-`git:write` policy is layered on top once the L2 carries the
 * door set — for now the chain proves the write came from a signed, linked launch.)
 */
export function verifyLaunchChain(args: {
  l3: L3Attestation;
  l2: LaunchAttestation;
  keeperKeyPem: string;
  launcherKeyPem: string;
  expectedCommit: string;
}): boolean {
  const { l3, l2, keeperKeyPem, launcherKeyPem, expectedCommit } = args;

  if (!verifyL3Attestation(l3, keeperKeyPem, expectedCommit)) return false;
  if (!verifyAttestation(l2, ed25519VerifierFor(launcherKeyPem))) return false;

  let l2Pred: ReturnType<typeof fromSLSA>;
  let l3Pred: ReturnType<typeof fromSLSA>;
  try {
    l2Pred = fromSLSA(l2.statement as SLSAStatement);
    l3Pred = fromSLSA(l3.statement as SLSAStatement);
  } catch {
    return false;
  }
  if (l2Pred.predicate.level !== "launch") return false;
  if (l3Pred.predicate.level !== "write") return false;

  const launchLink = (l3Pred.predicate.links ?? []).find((link) => link.level === "launch");
  if (!launchLink) return false;
  return launchLink.digest.sha256 === sha256(canonicalJson(l2.statement));
}
