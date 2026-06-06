import { describe, expect, test } from "bun:test";

import {
  ed25519Verifier,
  generateEd25519Keypair,
  ed25519Signer,
} from "@bounded-systems/anchored-chain";

import {
  IN_TOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  assembleSlsaEnvelope,
  builderId,
  signSlsaStatement,
  slsaProvenanceStatement,
  verifySlsaEnvelope,
  type SlsaProvenanceInput,
} from "../slsa.ts";

function input(overrides: Partial<SlsaProvenanceInput> = {}): SlsaProvenanceInput {
  return {
    buildType: "https://prx.dev/git/commit/v1",
    builderId: "prx://claude-code/submit",
    subject: [{ name: "commit", digest: { gitCommit: "a".repeat(40) } }],
    externalParameters: { subcommand: "commit", args: ["-m", "x"] },
    invocationId: "sha256:" + "b".repeat(64),
    startedOn: new Date(1000).toISOString(),
    ...overrides,
  };
}

describe("builderId", () => {
  test("formats prx://<actor>/<verb>", () => {
    expect(builderId({ actor: "claude-code", verb: "submit" })).toBe(
      "prx://claude-code/submit",
    );
  });

  test("falls back to 'unknown' when the verb is null", () => {
    expect(builderId({ actor: "claude-code", verb: null })).toBe(
      "prx://claude-code/unknown",
    );
  });

  // GH-352: the dispatch source is the provenance authority — it wins over the
  // executor `actor` so a leg-dispatched verb attributes to the dispatching leg.
  test("prefers the dispatch source over actor when present", () => {
    expect(builderId({ actor: "scout", verb: "read", source: "implement" })).toBe(
      "prx://implement/read",
    );
  });

  test("a null source falls back to actor (a direct call)", () => {
    expect(builderId({ actor: "claude-code", verb: "ci", source: null })).toBe(
      "prx://claude-code/ci",
    );
  });
});

describe("slsaProvenanceStatement", () => {
  test("projects onto the published SLSA Provenance v1 shape", () => {
    const stmt = slsaProvenanceStatement(input());
    expect(stmt._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(stmt.predicateType).toBe(SLSA_PROVENANCE_PREDICATE_TYPE);
    expect(stmt.subject).toEqual([
      { name: "commit", digest: { gitCommit: "a".repeat(40) } },
    ]);
    expect(stmt.predicate.buildDefinition.buildType).toBe(
      "https://prx.dev/git/commit/v1",
    );
    expect(stmt.predicate.buildDefinition.externalParameters).toEqual({
      subcommand: "commit",
      args: ["-m", "x"],
    });
    expect(stmt.predicate.buildDefinition.resolvedDependencies).toEqual([]);
    expect(stmt.predicate.runDetails.builder.id).toBe("prx://claude-code/submit");
    expect(stmt.predicate.runDetails.metadata.invocationId).toBe(
      "sha256:" + "b".repeat(64),
    );
    expect(stmt.predicate.runDetails.metadata.startedOn).toBe(
      new Date(1000).toISOString(),
    );
  });

  test("is pure: same input → identical Statement", () => {
    expect(slsaProvenanceStatement(input())).toEqual(
      slsaProvenanceStatement(input()),
    );
  });

  test("omits finishedOn when not supplied; carries it when present", () => {
    expect(
      "finishedOn" in slsaProvenanceStatement(input()).predicate.runDetails.metadata,
    ).toBe(false);
    const finished = new Date(2000).toISOString();
    expect(
      slsaProvenanceStatement(input({ finishedOn: finished })).predicate
        .runDetails.metadata.finishedOn,
    ).toBe(finished);
  });
});

describe("DSSE sign / verify over the SLSA Statement", () => {
  test("a signed envelope verifies against the existing Verifier", async () => {
    const kp = generateEd25519Keypair();
    const stmt = slsaProvenanceStatement(input());
    const envelope = await signSlsaStatement(stmt, ed25519Signer(kp.privateKey, kp.keyid));

    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]?.keyid).toBe(kp.keyid);
    expect(
      await verifySlsaEnvelope(stmt, envelope, ed25519Verifier(kp.publicKey)),
    ).toBe(true);
  });

  test("payload is the base64 of the canonical Statement JSON", async () => {
    const kp = generateEd25519Keypair();
    const stmt = slsaProvenanceStatement(input());
    const envelope = await signSlsaStatement(stmt, ed25519Signer(kp.privateKey, kp.keyid));
    const { envelope: unsigned } = assembleSlsaEnvelope(stmt);
    expect(envelope.payload).toBe(unsigned.payload);
    expect(Buffer.from(envelope.payload, "base64").toString("utf8")).toBe(
      JSON.stringify(stmt),
    );
  });

  test("a tampered Statement fails verification (envelope bound to payload)", async () => {
    const kp = generateEd25519Keypair();
    const stmt = slsaProvenanceStatement(input());
    const envelope = await signSlsaStatement(stmt, ed25519Signer(kp.privateKey, kp.keyid));
    const tampered = slsaProvenanceStatement(
      input({ subject: [{ name: "commit", digest: { gitCommit: "c".repeat(40) } }] }),
    );
    expect(
      await verifySlsaEnvelope(tampered, envelope, ed25519Verifier(kp.publicKey)),
    ).toBe(false);
  });

  test("a wrong key fails verification", async () => {
    const kp = generateEd25519Keypair();
    const other = generateEd25519Keypair();
    const stmt = slsaProvenanceStatement(input());
    const envelope = await signSlsaStatement(stmt, ed25519Signer(kp.privateKey, kp.keyid));
    expect(
      await verifySlsaEnvelope(stmt, envelope, ed25519Verifier(other.publicKey)),
    ).toBe(false);
  });
});
