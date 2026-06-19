import { describe, expect, test } from "bun:test";

import {
  assembleEnvelope,
  dssePae,
  manifestToStatement,
  statementToManifest,
  DSSE_PAYLOAD_TYPE,
  STATEMENT_TYPE,
  DERIVATION_PREDICATE_TYPE,
} from "../in-toto.ts";
import type { Derivation, Digest } from "../types.ts";

const D = (s: string) => `sha256:${s.padEnd(64, "0")}` as Digest;

const sampleManifest: Derivation["manifest"] = {
  producer: "agent:executor",
  inputs: { plan: D("plan"), context: D("ctx") },
  outputs: { patch: D("patch") },
  contracts: ["anchored/merge-requires-review"],
  params: { uow: "ai-home-abcd", attempt: 1 },
};

describe("in-toto Phase 0 adapter", () => {
  test("manifest → Statement shape is in-toto v1 with outputs as subjects", () => {
    const stmt = manifestToStatement(sampleManifest);
    expect(stmt._type).toBe(STATEMENT_TYPE);
    expect(stmt.predicateType).toBe(DERIVATION_PREDICATE_TYPE);
    expect(stmt.subject).toEqual([{ name: "patch", digest: { sha256: "patch".padEnd(64, "0") } }]);
    expect(stmt.predicate.materials).toEqual({
      plan: { sha256: "plan".padEnd(64, "0") },
      context: { sha256: "ctx".padEnd(64, "0") },
    });
    // digests are bare hex (no sha256: prefix) per in-toto convention
    expect(stmt.subject[0]!.digest.sha256).not.toContain("sha256:");
  });

  test("round-trip: statementToManifest(manifestToStatement(m)) === m", () => {
    const restored = statementToManifest(manifestToStatement(sampleManifest));
    expect(restored).toEqual(sampleManifest);
  });

  test("round-trip is stable for empty inputs/outputs", () => {
    const m: Derivation["manifest"] = {
      producer: "source:issue",
      inputs: {},
      outputs: {},
      contracts: [],
      params: {},
    };
    expect(statementToManifest(manifestToStatement(m))).toEqual(m);
  });

  test("assembleEnvelope wraps the Statement unsigned with a base64 payload", () => {
    const stmt = manifestToStatement(sampleManifest);
    const { envelope, pae } = assembleEnvelope(stmt);
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(envelope.signatures).toEqual([]);
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(decoded).toEqual(stmt);
    expect(pae.length).toBeGreaterThan(0);
  });

  test("DSSE PAE matches the spec vector", () => {
    // From the DSSE spec: PAE("http://example.com/HelloWorld", "hello world")
    const pae = dssePae("http://example.com/HelloWorld", new TextEncoder().encode("hello world"));
    expect(new TextDecoder().decode(pae)).toBe(
      "DSSEv1 29 http://example.com/HelloWorld 11 hello world",
    );
  });
});
