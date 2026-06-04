/**
 * prx-keymaker slice 2: per-actor signing + verification.
 *
 * The security property under test: a derivation is verified against the key of
 * the actor named in its OWN `builder.id`. So an attestation that *claims*
 * `prx://keeper/push` only verifies if it was signed with KEEPER's key — a
 * different actor's signature on a keeper claim is rejected. That is "only the
 * actor can sign as itself", enforced at the verify boundary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519Signer, type Derivation } from "@bounded-systems/anchored-chain";

import { actorSigningIdentity, deriveActorKeypair } from "../../src/provenance/actor-identity.ts";
import { loadOrCreateDevMaster } from "../../src/provenance/dev-key.ts";
import {
  actorFromBuilderId,
  ACTOR_DEV_SIGNER_MODE,
  isPerActorMode,
  PER_ACTOR_ENV,
  PROVENANCE_KEY_ENV,
  resolveActorVerifierForDerivation,
} from "../../src/provenance/signer.ts";
import { signSlsaStatement, slsaProvenanceStatement } from "../../src/provenance/slsa.ts";
import { verifySlsaDerivation } from "../../src/provenance/verify.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

let stateDir: string;
function envFor(): (key: string) => string | undefined {
  return (k) =>
    k === "XDG_STATE_HOME" ? stateDir : k === PROVENANCE_KEY_ENV ? ACTOR_DEV_SIGNER_MODE : undefined;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "prx-actor-signer-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Build a signed push/v1 derivation that CLAIMS `claimActor`, signed by `signActor`'s key. */
async function signedDerivation(claimActor: string, signActor: string): Promise<Derivation> {
  const env = envFor();
  const master = loadOrCreateDevMaster(env);
  const kp = deriveActorKeypair(master, actorSigningIdentity(signActor));
  const statement = slsaProvenanceStatement({
    buildType: "https://prx.dev/git/push/v1",
    builderId: `prx://${claimActor}/push`,
    subject: [{ name: "commit", digest: { gitCommit: COMMIT } }],
    invocationId: "inv-1",
    startedOn: "2026-06-04T00:00:00.000Z",
  });
  const envelope = await signSlsaStatement(statement, ed25519Signer(kp.privateKey, kp.keyid));
  return { derivationId: "d1" as Derivation["derivationId"], manifest: {} as Derivation["manifest"], envelope, ts: 0 };
}

describe("per-actor signing + verification (prx-keymaker slice 2)", () => {
  test("actorFromBuilderId parses the actor; null on a malformed id", () => {
    expect(actorFromBuilderId("prx://keeper/push")).toBe("keeper");
    expect(actorFromBuilderId("prx://implement/commit")).toBe("implement");
    expect(actorFromBuilderId("not-a-builder-id")).toBeNull();
  });

  test("keeper-signed + keeper-claimed derivation VERIFIES (the actor signed as itself)", async () => {
    const derivation = await signedDerivation("keeper", "keeper");
    const verifier = resolveActorVerifierForDerivation(derivation, envFor());
    expect(verifier).not.toBeNull();
    expect(await verifySlsaDerivation(derivation, verifier!)).toBe(true);
  });

  test("plan-signed but keeper-claimed derivation is REJECTED (can't sign as another actor)", async () => {
    // Signed with plan's key, but the builder.id claims keeper → the verifier
    // resolves KEEPER's key, which does not match plan's signature.
    const forged = await signedDerivation("keeper", "plan");
    const verifier = resolveActorVerifierForDerivation(forged, envFor());
    expect(verifier).not.toBeNull();
    expect(await verifySlsaDerivation(forged, verifier!)).toBe(false);
  });

  test("an envelope-less derivation resolves no verifier (fail-closed)", () => {
    expect(resolveActorVerifierForDerivation({}, envFor())).toBeNull();
  });

  test("per-actor is the DEFAULT for dev mode — opt-out, not opt-in (prx-1bo)", () => {
    const dev = (k: string) => (k === PROVENANCE_KEY_ENV ? "dev" : undefined);
    expect(isPerActorMode(dev)).toBe(true); // default ON for dev

    const optedOut = (k: string) =>
      k === PROVENANCE_KEY_ENV ? "dev" : k === PER_ACTOR_ENV ? "off" : undefined;
    expect(isPerActorMode(optedOut)).toBe(false); // escape hatch → single key

    const explicit = (k: string) => (k === PROVENANCE_KEY_ENV ? "actor-dev" : undefined);
    expect(isPerActorMode(explicit)).toBe(true); // alias still works

    expect(isPerActorMode(() => undefined)).toBe(false); // no signer ⇒ off
  });

  test("per-actor verification works under plain `dev` mode (the new default)", async () => {
    // dev mode (NOT actor-dev): per-actor is on by default, so the actor
    // resolved from builder.id verifies.
    const dev = (k: string) =>
      k === "XDG_STATE_HOME" ? stateDir : k === PROVENANCE_KEY_ENV ? "dev" : undefined;
    const kp = deriveActorKeypair(loadOrCreateDevMaster(dev), actorSigningIdentity("keeper"));
    const statement = slsaProvenanceStatement({
      buildType: "https://prx.dev/git/push/v1",
      builderId: "prx://keeper/push",
      subject: [{ name: "commit", digest: { gitCommit: COMMIT } }],
      invocationId: "inv-dev",
      startedOn: "2026-06-04T00:00:00.000Z",
    });
    const envelope = await signSlsaStatement(statement, ed25519Signer(kp.privateKey, kp.keyid));
    const derivation: Derivation = {
      derivationId: "d-dev" as Derivation["derivationId"],
      manifest: {} as Derivation["manifest"],
      envelope,
      ts: 0,
    };
    const verifier = resolveActorVerifierForDerivation(derivation, dev);
    expect(verifier).not.toBeNull();
    expect(await verifySlsaDerivation(derivation, verifier!)).toBe(true);
  });
});
