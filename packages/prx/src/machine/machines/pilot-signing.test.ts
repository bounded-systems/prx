import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpDir } from "@bounded-systems/host";
import { join } from "node:path";
import { createActor, waitFor, type AnyStateMachine } from "xstate";

import { ed25519Signer, ed25519Verifier, generateEd25519Keypair } from "@bounded-systems/anchored-chain";
import { resolveProvenanceSigner, resolveProvenanceVerifier } from "../../provenance/signer.ts";

import { createFleetMachine } from "./fleet.ts";
import { createPilotMachine, stubLegRunner } from "./pilot.ts";
import {
  realRoleSigner,
  realStatementSigner,
  verifyLeg,
  verifyStatement,
} from "./pilot-signing.ts";

describe("real ed25519/DSSE signing of pilot + fleet artifacts", () => {
  test("the pilot summary is genuinely signed and verifies", async () => {
    const kp = generateEd25519Keypair();
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const verifier = ed25519Verifier(kp.publicKey);

    const actor = createActor(
      createPilotMachine({ runLeg: stubLegRunner, signSummary: realStatementSigner(signer) }),
      { input: { workUnitId: "prx-signed" } },
    ).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    const summary = done.context.summary!;
    expect(summary.signedBy).toBe(kp.keyid); // real keyid, not a stub label
    expect(await verifyStatement(verifier, summary)).toBe(true);
  });

  test("a tampered statement fails verification", async () => {
    const kp = generateEd25519Keypair();
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const verifier = ed25519Verifier(kp.publicKey);

    const actor = createActor(
      createPilotMachine({ runLeg: stubLegRunner, signSummary: realStatementSigner(signer) }),
      { input: { workUnitId: "prx-tamper" } },
    ).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });
    const summary = done.context.summary!;

    const tampered = {
      ...summary,
      predicate: { ...(summary.predicate as object), legCount: 999 },
    };
    expect(await verifyStatement(verifier, tampered)).toBe(false);

    // A different key also rejects the genuine statement.
    const other = ed25519Verifier(generateEd25519Keypair().publicKey);
    expect(await verifyStatement(other, summary)).toBe(false);
  });

  test("the fleet batch statement is signed and verifies", async () => {
    const kp = generateEd25519Keypair();
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const verifier = ed25519Verifier(kp.publicKey);

    const makePilot = (_u: string): AnyStateMachine =>
      createPilotMachine({ runLeg: stubLegRunner, signSummary: realStatementSigner(signer) }) as AnyStateMachine;

    const fleet = createActor(
      createFleetMachine(makePilot, { signBatch: realStatementSigner(signer) }),
      { input: { units: ["prx-a", "prx-b"], wip: 2 } },
    ).start();
    const drained = await waitFor(fleet, (s) => s.status === "done", { timeout: 4000 });

    const batch = drained.output!.batch!;
    expect(batch.predicateType).toBe("prx.fleet/v1");
    expect(await verifyStatement(verifier, batch)).toBe(true);
  });

  test("a leg link signs and verifies against its outputHash", async () => {
    const kp = generateEd25519Keypair();
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const verifier = ed25519Verifier(kp.publicKey);

    const sign = realRoleSigner(signer);
    const att = await sign({
      role: "executor",
      subject: "prx-x:implement@latest",
      predicate: "executor.completed",
      outputHash: "deadbeef",
    });
    const link = { stage: "executor", subject: "prx-x:implement@latest", predicate: "executor.completed", sig: att.sig };

    expect(await verifyLeg(verifier, link, "deadbeef")).toBe(true);
    expect(await verifyLeg(verifier, link, "cafe")).toBe(false); // wrong content
  });

  test("the real ambient resolver (dev mode) round-trips end to end", async () => {
    // Isolate the persisted dev key under a temp state dir.
    const stateDir = mkdtempSync(join(tmpDir(), "prx-prov-"));
    const env = (k: string): string | undefined =>
      ({
        PRX_PROVENANCE_KEY: "dev",
        PRX_PROVENANCE_PER_ACTOR: "off",
        XDG_STATE_HOME: stateDir,
      })[k];

    const signer = resolveProvenanceSigner(env);
    const verifier = resolveProvenanceVerifier(env);
    expect(signer).not.toBeNull();
    expect(verifier).not.toBeNull();

    const sign = realStatementSigner(signer!);
    const att = await sign({
      predicateType: "prx.pilot/v1",
      subject: [{ name: "prx-dev", digest: { sha256: "abc" } }],
      predicate: { legCount: 1 },
    });
    const stmt = {
      _type: "https://in-toto.io/Statement/v1" as const,
      subject: [{ name: "prx-dev", digest: { sha256: "abc" } }],
      predicateType: "prx.pilot/v1",
      predicate: { legCount: 1 },
      signedBy: att.signedBy,
      sig: att.sig,
    };
    expect(await verifyStatement(verifier!, stmt)).toBe(true);
  });
});
