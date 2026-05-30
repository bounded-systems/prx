import { describe, expect, test } from "bun:test";

import { digestManifest, openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import { sha256Hex } from "@bounded-systems/cas";

import { formatScoutReadJson, type ScoutReadResult } from "../read.ts";
import {
  formatScoutReadProvenanceJson,
  recordScoutReadDerivation,
  scoutReadDerivation,
  scoutReadProvenance,
  IN_TOTO_STATEMENT_TYPE,
  SCOUT_READ_BUILD_TYPE,
  SCOUT_READ_BUILDER_ID,
  SCOUT_READ_CONTRACT,
  SCOUT_READ_PRODUCER,
  SLSA_PROVENANCE_PREDICATE_TYPE,
} from "../provenance.ts";

function fixture(overrides: Partial<ScoutReadResult> = {}): ScoutReadResult {
  return {
    path: "/repo/src/x.ts",
    sha256: "a".repeat(64),
    bytes: 12,
    lines: 3,
    truncated: false,
    content: "hello\nworld\n",
    ...overrides,
  };
}

describe("scoutReadDerivation", () => {
  test("derivationId is the manifest digest (reproducible)", () => {
    const d = scoutReadDerivation(fixture(), { now: 1000 });
    expect(d.derivationId).toBe(digestManifest(d.manifest));
    // Same input + clock → identical id.
    expect(scoutReadDerivation(fixture(), { now: 1000 }).derivationId).toBe(
      d.derivationId,
    );
  });

  test("inputs carry the file content digest; outputs carry the envelope digest", () => {
    const result = fixture();
    const d = scoutReadDerivation(result, { now: 1000 });
    expect(d.manifest.producer).toBe(SCOUT_READ_PRODUCER);
    expect(String(d.manifest.inputs.source)).toBe(`sha256:${result.sha256}`);
    expect(d.manifest.outputs.envelope).toBe(
      sha256Hex(formatScoutReadJson(result)),
    );
    expect(d.manifest.contracts).toEqual([SCOUT_READ_CONTRACT]);
    expect(d.manifest.params).toEqual({
      path: result.path,
      bytes: result.bytes,
      lines: result.lines,
      truncated: result.truncated,
    });
  });

  test("a different file produces a different derivation id", () => {
    const a = scoutReadDerivation(fixture({ sha256: "a".repeat(64) }), { now: 1 });
    const b = scoutReadDerivation(fixture({ sha256: "b".repeat(64) }), { now: 1 });
    expect(a.derivationId).not.toBe(b.derivationId);
  });
});

describe("recordScoutReadDerivation — ledger", () => {
  test("appends and is queryable; lineage links the source file", async () => {
    const store = openAnchoredChain(":memory:");
    try {
      const result = fixture();
      const d = await recordScoutReadDerivation(store.derivations, result, {
        now: 1000,
      });

      const fetched = await store.derivations.get(d.derivationId);
      expect(fetched?.derivationId).toBe(d.derivationId);

      // "Which scout reads consumed this file?" — the provenance query the
      // ledger exists to answer.
      const consumers = await store.invalidate.descendants(
        `sha256:${result.sha256}` as Parameters<typeof store.invalidate.descendants>[0],
      );
      expect(consumers).toContain(d.derivationId);
    } finally {
      store.close();
    }
  });

  test("idempotent: re-recording an identical read does not duplicate", async () => {
    const store = openAnchoredChain(":memory:");
    try {
      const result = fixture();
      const first = await recordScoutReadDerivation(store.derivations, result, {
        now: 1000,
      });
      const second = await recordScoutReadDerivation(store.derivations, result, {
        now: 1000,
      });
      expect(second.derivationId).toBe(first.derivationId);
      const inputs = await store.derivations.listInputs(first.derivationId);
      expect(inputs).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("scoutReadProvenance — SLSA Provenance v1 export", () => {
  test("projects onto the published in-toto/SLSA shape", () => {
    const result = fixture();
    const stmt = scoutReadProvenance(result, { now: 1000 });
    const derivation = scoutReadDerivation(result, { now: 1000 });

    expect(stmt._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(stmt.predicateType).toBe(SLSA_PROVENANCE_PREDICATE_TYPE);

    // Subject = the produced envelope; its digest equals the ledger output.
    const envelopeHex = (derivation.manifest.outputs.envelope as string).slice(
      "sha256:".length,
    );
    expect(stmt.subject).toEqual([
      { name: "envelope", digest: { sha256: envelopeHex } },
    ]);

    // Resolved dependency = the source file content the read consumed.
    expect(stmt.predicate.buildDefinition.buildType).toBe(SCOUT_READ_BUILD_TYPE);
    expect(stmt.predicate.buildDefinition.resolvedDependencies).toEqual([
      { name: "source", digest: { sha256: result.sha256 } },
    ]);
    expect(stmt.predicate.buildDefinition.externalParameters).toEqual({
      path: result.path,
      bytes: result.bytes,
      lines: result.lines,
      truncated: result.truncated,
    });

    expect(stmt.predicate.runDetails.builder.id).toBe(SCOUT_READ_BUILDER_ID);
    expect(stmt.predicate.runDetails.metadata.invocationId).toBe(
      derivation.derivationId as string,
    );
    expect(stmt.predicate.runDetails.metadata.startedOn).toBe(
      new Date(1000).toISOString(),
    );
  });

  test("formatScoutReadProvenanceJson emits a single JSON object + newline", () => {
    const text = formatScoutReadProvenanceJson(fixture(), { now: 1000 });
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.predicateType).toBe(SLSA_PROVENANCE_PREDICATE_TYPE);
    expect(parsed.predicate.runDetails.builder.id).toBe(SCOUT_READ_BUILDER_ID);
  });
});
