/**
 * Spike — signed ref-snapshot + artifact provenance (OCAP-grade repo identity)
 * =============================================================================
 *
 * See docs/prx/articles/02-capability-security.md and bead prx-eyff / prx-0wsf.
 *
 * Today prx derives repo "identity" (dolt db names, dolt server ids, workspace
 * ledger ids, canonical bare/worktree paths) entirely from a git remote URL
 * string. That proves nothing cryptographically — a string match is not an
 * OCAP (an unforgeable capability), it's a lookup. This spike builds the real
 * two-assertion model:
 *
 *   artifact digest
 *       -- trusted build provenance -->  commit C
 *       -- trusted forge assertion  -->  C was refs/heads/main in repo R
 *                                        signed by the repository authority
 *
 * Two independent signers, two independent keys:
 *   - the REPOSITORY AUTHORITY signs a ref-snapshot: "refs/heads/main == commit
 *     C in repo R at time T" — the local equivalent of a signed push
 *     certificate / signed tag observation.
 *   - the BUILDER signs artifact provenance binding an artifact digest to a
 *     commit, and REFERENCES the ref-snapshot's digest rather than trusting
 *     its own claim about which ref that commit came from.
 *
 * Verification requires BOTH signatures to check out, over BOTH the linkage
 * (provenance references the exact ref-snapshot digest) and the content
 * (repo/ref/commit fields actually match). Same "no signed X -> no Y" ocap
 * rule as docs/spikes/signed-prompt-evolution/poc.ts, applied to provenance
 * instead of prompt promotion — same anchored-chain primitives, no new crypto.
 *
 * Everything is deterministic + offline ($0): stub commits/digests, real
 * ed25519 (generateEd25519Keypair / ed25519Signer / ed25519Verifier), real
 * DSSE pre-auth encoding (dssePae), real content-addressed manifests
 * (digestManifest).
 *
 * Run (bun on PATH):  bun docs/spikes/signed-ref-snapshot/poc.ts
 */

import {
  type Derivation,
  type Digest,
  type DsseEnvelope,
  canonicalJson,
  digestManifest,
  dssePae,
  DSSE_PAYLOAD_TYPE,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  sha256Hex,
} from "@bounded-systems/anchored-chain";

const log = (line: string) => console.log(line);
const d = (s: string): Digest => sha256Hex(s);

// ---------------------------------------------------------------------------
// 1. The repository authority's signed ref-snapshot
// ---------------------------------------------------------------------------

/** A signed observation: "repo R's ref == commit C, as of sequence N." */
type RefSnapshot = { derivation: Derivation; envelope: DsseEnvelope };

async function mintRefSnapshot(args: {
  repository: string; // immutable repo id, e.g. urn:uuid:...
  ref: string; // e.g. "refs/heads/main"
  commit: string; // the commit OID being observed
  sequence: number; // monotonic observation counter (detects replay of a stale snapshot)
  signer: ReturnType<typeof ed25519Signer>;
  keyid: string;
}): Promise<RefSnapshot> {
  const manifest: Derivation["manifest"] = {
    producer: "repository-authority",
    inputs: {
      repository: d(args.repository),
      ref: d(args.ref),
      sequence: d(String(args.sequence)),
    },
    outputs: { commit: d(args.commit) },
    contracts: ["ref-snapshot@1"],
    params: { repository: args.repository, ref: args.ref, commit: args.commit },
  };
  const derivationId = digestManifest(manifest);
  const derivation: Derivation = { derivationId, manifest, ts: args.sequence };

  const payload = canonicalJson(manifest);
  const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(payload));
  const sig = await args.signer.sign(pae);
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [sig],
  };
  return { derivation, envelope };
}

async function verifyRefSnapshot(
  snap: RefSnapshot,
  verifier: ReturnType<typeof ed25519Verifier>,
): Promise<boolean> {
  const payload = canonicalJson(snap.derivation.manifest);
  const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(payload));
  const sig = snap.envelope.signatures[0];
  if (!sig) return false;
  return verifier.verify(pae, sig);
}

// ---------------------------------------------------------------------------
// 2. The builder's signed artifact provenance — SLSA-shaped, referencing the
//    ref-snapshot's digest rather than asserting its own ref/branch claim.
// ---------------------------------------------------------------------------

type Provenance = { derivation: Derivation; envelope: DsseEnvelope; artifactDigest: Digest };

async function mintProvenance(args: {
  artifactDigest: Digest;
  commit: string;
  refSnapshotDigest: string; // binds to the signed ref-snapshot, not a bare claim
  builderId: string;
  signer: ReturnType<typeof ed25519Signer>;
  keyid: string;
}): Promise<Provenance> {
  const manifest: Derivation["manifest"] = {
    producer: args.builderId,
    inputs: {
      commit: d(args.commit),
      refSnapshotDigest: d(args.refSnapshotDigest),
    },
    outputs: { artifact: args.artifactDigest },
    contracts: ["slsa-build-provenance@1"],
    params: { commit: args.commit, refSnapshotDigest: args.refSnapshotDigest },
  };
  const derivationId = digestManifest(manifest);
  const derivation: Derivation = { derivationId, manifest, ts: 0 };

  const payload = canonicalJson(manifest);
  const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(payload));
  const sig = await args.signer.sign(pae);
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [sig],
  };
  return { derivation, envelope, artifactDigest: args.artifactDigest };
}

// ---------------------------------------------------------------------------
// 3. The verifier — the canonical rule from the design sketch, in code.
// ---------------------------------------------------------------------------

type VerifyResult = { ok: boolean; reason: string };

async function verifyArtifact(args: {
  artifactDigest: Digest;
  expectedRepository: string;
  expectedRef: string;
  provenance: Provenance;
  refSnapshot: RefSnapshot;
  builderVerifier: ReturnType<typeof ed25519Verifier>;
  authorityVerifier: ReturnType<typeof ed25519Verifier>;
}): Promise<VerifyResult> {
  // 1. Provenance subject matches the artifact actually in hand.
  if (args.provenance.artifactDigest !== args.artifactDigest) {
    return { ok: false, reason: "artifact digest does not match provenance subject" };
  }

  // 2. Provenance signature verifies under the trusted builder key.
  const provPayload = canonicalJson(args.provenance.derivation.manifest);
  const provPae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(provPayload));
  const provSig = args.provenance.envelope.signatures[0];
  if (!provSig || !(await args.builderVerifier.verify(provPae, provSig))) {
    return { ok: false, reason: "provenance signature does not verify" };
  }

  // 3. Provenance references the exact ref-snapshot digest presented.
  if (
    args.provenance.derivation.manifest.inputs.refSnapshotDigest !==
    d(args.refSnapshot.derivation.derivationId)
  ) {
    return { ok: false, reason: "provenance does not reference the presented ref-snapshot" };
  }

  // 4. Ref-snapshot signature verifies under the trusted repository-authority key.
  if (!(await verifyRefSnapshot(args.refSnapshot, args.authorityVerifier))) {
    return { ok: false, reason: "ref-snapshot signature does not verify" };
  }

  // 5. Ref-snapshot content actually matches what we expect (repo, ref) —
  //    and its committed commit matches what the provenance claims it built.
  const params = args.refSnapshot.derivation.manifest.params as {
    repository: string;
    ref: string;
    commit: string;
  };
  if (params.repository !== args.expectedRepository) {
    return { ok: false, reason: "ref-snapshot repository does not match expected repository" };
  }
  if (params.ref !== args.expectedRef) {
    return { ok: false, reason: "ref-snapshot ref does not match expected ref" };
  }
  const provParams = args.provenance.derivation.manifest.params as { commit: string };
  if (params.commit !== provParams.commit) {
    return { ok: false, reason: "ref-snapshot commit does not match provenance commit" };
  }

  return { ok: true, reason: `verified — ${args.expectedRef} == ${params.commit} in ${args.expectedRepository}` };
}

// ---------------------------------------------------------------------------
// 4. Demo
// ---------------------------------------------------------------------------

async function main() {
  const authorityKeys = generateEd25519Keypair();
  const authoritySigner = ed25519Signer(authorityKeys.privateKey, authorityKeys.keyid);
  const authorityVerifier = ed25519Verifier(authorityKeys.publicKey);

  const builderKeys = generateEd25519Keypair();
  const builderSigner = ed25519Signer(builderKeys.privateKey, builderKeys.keyid);
  const builderVerifier = ed25519Verifier(builderKeys.publicKey);

  const repository = "urn:uuid:8b9d2e10-1c3a-4b7e-9f2d-6a1c0e4f5a3b";
  const ref = "refs/heads/main";
  const commit = "abc123def456";
  const artifactDigest = d("artifact.tar contents");

  log("── signed ref-snapshot + artifact provenance ───────────────────────");
  log(`repository=${repository.slice(0, 18)}…  ref=${ref}  commit=${commit}`);
  log(`authority.keyid=${authorityKeys.keyid.slice(0, 16)}…  builder.keyid=${builderKeys.keyid.slice(0, 16)}…`);

  // -- The repository authority observes and signs the branch head --------
  const refSnapshot = await mintRefSnapshot({
    repository,
    ref,
    commit,
    sequence: 481,
    signer: authoritySigner,
    keyid: authorityKeys.keyid,
  });
  log(`\nauthority.sign  ref-snapshot=${refSnapshot.derivation.derivationId.slice(0, 12)}… signed`);

  // -- The builder produces provenance referencing that exact snapshot ----
  const provenance = await mintProvenance({
    artifactDigest,
    commit,
    refSnapshotDigest: refSnapshot.derivation.derivationId,
    builderId: "spiffe://bounded.local/builder/release",
    signer: builderSigner,
    keyid: builderKeys.keyid,
  });
  log(`builder.sign    provenance=${provenance.derivation.derivationId.slice(0, 12)}… signed`);

  // -- Happy path: everything checks out -----------------------------------
  const verify = (p: Provenance, s: RefSnapshot, artifact = artifactDigest) =>
    verifyArtifact({
      artifactDigest: artifact,
      expectedRepository: repository,
      expectedRef: ref,
      provenance: p,
      refSnapshot: s,
      builderVerifier,
      authorityVerifier,
    });

  const happy = await verify(provenance, refSnapshot);
  log(`verify.happy    ${happy.ok ? "OK" : "DENIED"} — ${happy.reason}`);

  // -- Tamper: forge the ref-snapshot's commit after the fact --------------
  const forgedSnapshot: RefSnapshot = {
    ...refSnapshot,
    derivation: {
      ...refSnapshot.derivation,
      manifest: {
        ...refSnapshot.derivation.manifest,
        params: { ...(refSnapshot.derivation.manifest.params as object), commit: "evil000" },
      },
    },
  };
  const tamperedSnapshot = await verify(provenance, forgedSnapshot);
  log(`tamper.snapshot ${tamperedSnapshot.ok ? "OK" : "DENIED"} — ${tamperedSnapshot.reason}`);

  // -- Tamper: swap in a different artifact than the one provenance covers -
  const swappedArtifact = await verify(provenance, refSnapshot, d("a different artifact"));
  log(`tamper.artifact ${swappedArtifact.ok ? "OK" : "DENIED"} — ${swappedArtifact.reason}`);

  // -- Forged key: sign the ref-snapshot with an untrusted key -------------
  const evilKeys = generateEd25519Keypair();
  const evilSigner = ed25519Signer(evilKeys.privateKey, evilKeys.keyid);
  const forgedKeySnapshot = await mintRefSnapshot({
    repository,
    ref,
    commit,
    sequence: 482,
    signer: evilSigner,
    keyid: evilKeys.keyid,
  });
  const forgedKeyResult = await verify(provenance, forgedKeySnapshot);
  log(`forged.key      ${forgedKeyResult.ok ? "OK" : "DENIED"} — ${forgedKeyResult.reason}`);

  // -- Unlinked: provenance that never referenced this ref-snapshot at all -
  const unlinkedProvenance = await mintProvenance({
    artifactDigest,
    commit,
    refSnapshotDigest: "sha256:not-the-real-snapshot",
    builderId: "spiffe://bounded.local/builder/release",
    signer: builderSigner,
    keyid: builderKeys.keyid,
  });
  const unlinkedResult = await verify(unlinkedProvenance, refSnapshot);
  log(`forged.unlinked ${unlinkedResult.ok ? "OK" : "DENIED"} — ${unlinkedResult.reason}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
