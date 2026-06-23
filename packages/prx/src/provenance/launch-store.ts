/**
 * L2 launch-attestation distribution (capability chain, content-addressed).
 *
 * The launcher stores a signed L2 in the CAS keyed by its content-address
 * (`l2LaunchDigest = sha256(canonicalJson(statement))`); the gate resolves it by
 * the L3 write's launch link. An in-toto DAG node, not an out-of-band fetch — the
 * anchored-chain ledger is the durable home, addressed by digest.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@bounded-systems/ocap-provenance/attestation";
import { fromSLSA, type SLSAStatement } from "@bounded-systems/ocap-provenance/slsa";

import { getRef, readBlob, setRef, writeBlob, type DomainOptions } from "../plan-store/cas.ts";
import type { LaunchAttestation } from "./verify-chain.ts";
import type { L3Attestation } from "./verify-l3.ts";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The CAS ref a launch attestation lives under (keyed by its content-address;
 *  hyphen-joined — ref names forbid `/`). */
function refFor(l2LaunchDigest: string): string {
  return `launch-${l2LaunchDigest}`;
}

/** The content-address of a launch attestation (what an L3 write links back to). */
export function launchDigestOf(l2: LaunchAttestation): string {
  return sha256hex(canonicalJson(l2.statement));
}

/**
 * Store a signed L2 launch attestation in the CAS, keyed by its content-address,
 * so an L3 write that links it can be resolved at the gate. Returns the
 * `l2LaunchDigest` the box's keeper push should link.
 */
export async function storeLaunchAttestation(
  l2: LaunchAttestation,
  opts?: DomainOptions,
): Promise<string> {
  const digest = launchDigestOf(l2);
  const { sha } = await writeBlob(JSON.stringify(l2), opts);
  await setRef(refFor(digest), sha, opts);
  return digest;
}

/**
 * Resolve the L2 launch attestation an L3 links to (by its launch-link digest),
 * or `null` if the L3 has no launch link or the L2 isn't stored. This is the
 * gate's default `resolveLaunchAttestation`.
 */
export async function resolveLaunchAttestationFromCas(
  l3: L3Attestation,
  opts?: DomainOptions,
): Promise<LaunchAttestation | null> {
  let digest: string | undefined;
  try {
    const pred = fromSLSA(l3.statement as SLSAStatement);
    digest = (pred.predicate.links ?? []).find((l) => l.level === "launch")?.digest.sha256;
  } catch {
    return null;
  }
  if (digest === undefined) return null;
  const sha = await getRef(refFor(digest), opts);
  if (sha === null) return null;
  try {
    return JSON.parse((await readBlob(sha, opts)).toString("utf8")) as LaunchAttestation;
  } catch {
    return null;
  }
}
