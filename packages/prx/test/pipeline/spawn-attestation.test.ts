/**
 * GH-293: the signed SLSA-v1 spawn attestation. The contract: minting binds the
 * leg to its consumed input (materials = the input artifact digest), the signed
 * statement round-trips, a tampered/foreign material or signature fails, and a
 * spawn cannot be minted without an input material.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  provenanceSigner,
  provenanceVerifier,
  realStatementSigner,
} from "../../src/machine/machines/pilot-signing.ts";
import type { StatementSigner } from "../../src/machine/machines/provenance.ts";
import type { Verifier } from "../../src/machine/machines/pilot-signing.ts";
import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
} from "@bounded-systems/anchored-chain";
import {
  PRX_SPAWN_BUILD_TYPE,
  SLSA_PROVENANCE_V1,
  mintSpawnAttestation,
  spawnEdge,
  verifySpawn,
} from "../../src/pipeline/spawn-attestation.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";

let prevRoot: string | undefined;
let prevKey: string | undefined;
let prevPerActor: string | undefined;
let signer: StatementSigner;
let verifier: Verifier;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  prevKey = process.env.PRX_PROVENANCE_KEY;
  prevPerActor = process.env.PRX_PROVENANCE_PER_ACTOR;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "gh-293-spawn-"));
  process.env.PRX_PROVENANCE_KEY = "dev";
  process.env.PRX_PROVENANCE_PER_ACTOR = "off";
  signer = realStatementSigner(provenanceSigner()!);
  verifier = provenanceVerifier()!;
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
  if (prevKey === undefined) delete process.env.PRX_PROVENANCE_KEY;
  else process.env.PRX_PROVENANCE_KEY = prevKey;
  if (prevPerActor === undefined) delete process.env.PRX_PROVENANCE_PER_ACTOR;
  else process.env.PRX_PROVENANCE_PER_ACTOR = prevPerActor;
});

const args = (over: Record<string, unknown> = {}) => ({
  unit: "GH-293",
  role: "plan",
  actor: "pilot",
  input: { ref: "GH-293:source@pinned", sha: "sha256:abc123" },
  interaction: "headless",
  invocationId: "plan/gh-293",
  ...over,
});

describe("spawn attestation (GH-293)", () => {
  test("mint persists a SLSA-v1 statement binding the input as the material", async () => {
    const { statement, emit } = await mintSpawnAttestation(args(), signer);
    expect(emit.ref).toBe("GH-293:spawn@plan");
    expect(statement.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(statement.predicate.buildDefinition.buildType).toBe(PRX_SPAWN_BUILD_TYPE);
    expect(statement.predicate.runDetails.builder.id).toBe("prx-claude://plan");
    const dep = statement.predicate.buildDefinition.resolvedDependencies[0]!;
    expect(dep.uri).toBe("GH-293:source@pinned");
    expect(dep.digest.sha256).toBe("sha256:abc123");

    // Persisted + re-consumable.
    const got = await consumeArtifact(spawnEdge("plan"), "GH-293");
    expect(got.missing).toBeUndefined();
    expect(got.value?.subject[0]?.name).toBe("GH-293:plan@spawn");
  });

  test("verifySpawn: valid signature + matching material ⇒ ok", async () => {
    await mintSpawnAttestation(args({ unit: "GH-ok" }), signer);
    const r = await verifySpawn("GH-ok", "plan", verifier, { expectedInputSha: "sha256:abc123" });
    expect(r.ok).toBe(true);
  });

  test("verifySpawn: material mismatch ⇒ not ok", async () => {
    await mintSpawnAttestation(args({ unit: "GH-drift" }), signer);
    const r = await verifySpawn("GH-drift", "plan", verifier, {
      expectedInputSha: "sha256:DIFFERENT",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("material-mismatch");
  });

  test("verifySpawn: foreign verifier ⇒ bad-signature", async () => {
    await mintSpawnAttestation(args({ unit: "GH-forge" }), signer);
    const kp = generateEd25519Keypair();
    const foreign = ed25519Verifier(kp.publicKey);
    const r = await verifySpawn("GH-forge", "plan", foreign);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  test("verifySpawn: missing ⇒ not ok", async () => {
    const r = await verifySpawn("GH-never", "plan", verifier);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  test("mint refuses with no input material (no spawn without an artifact)", async () => {
    await expect(
      mintSpawnAttestation(args({ unit: "GH-noinput", input: { ref: "x", sha: "" } }), signer),
    ).rejects.toThrow(/no input material/i);
  });
});
