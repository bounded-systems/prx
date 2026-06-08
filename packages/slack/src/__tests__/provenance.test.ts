import { describe, expect, test } from "bun:test";

import { digestManifest, openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import { sha256Hex } from "@bounded-systems/cas";

import { canonicalJson, formatSlackReadEnvelope, type SlackReadEnvelope } from "@bounded-systems/slack";
import {
  formatSlackReadProvenanceJson,
  recordSlackReadDerivation,
  slackReadDerivation,
  slackReadProducer,
  slackReadProvenance,
  IN_TOTO_STATEMENT_TYPE,
  SLACK_READ_BUILD_TYPE,
  SLACK_READ_BUILDER_ID,
  SLACK_READ_CONTRACT,
  SLSA_PROVENANCE_PREDICATE_TYPE,
} from "@bounded-systems/slack";

function envFixture(overrides: Partial<SlackReadEnvelope> = {}): SlackReadEnvelope {
  return {
    op: "history",
    params: { channel: "C1", limit: 10 },
    result: { ok: true, data: { messages: [] }, cursor: null },
    sha256: "a".repeat(64),
    keyId: "slack-k1-1000",
    scope: { ops: ["history"], channels: ["C1"] },
    expiresAt: 61_000,
    policy: {
      allowed: true,
      tool: "slack",
      subcommand: "history",
      state: "validating",
      role: "executor",
    },
    ...overrides,
  };
}

describe("slackReadDerivation", () => {
  test("derivationId is the manifest digest (reproducible)", () => {
    const d = slackReadDerivation(envFixture(), { now: 1000 });
    expect(d.derivationId).toBe(digestManifest(d.manifest));
    expect(slackReadDerivation(envFixture(), { now: 1000 }).derivationId).toBe(d.derivationId);
  });

  test("producer is per-op; contract is slack.read/v1", () => {
    const d = slackReadDerivation(envFixture(), { now: 1000 });
    expect(d.manifest.producer).toBe("slack.history");
    expect(slackReadProducer("users")).toBe("slack.users");
    expect(d.manifest.contracts).toEqual([SLACK_READ_CONTRACT]);
  });

  test("inputs carry the query digest; outputs carry the envelope digest", () => {
    const env = envFixture();
    const d = slackReadDerivation(env, { now: 1000 });
    expect(d.manifest.inputs.query).toBe(
      sha256Hex(canonicalJson({ op: env.op, params: env.params })),
    );
    expect(d.manifest.outputs.envelope).toBe(sha256Hex(formatSlackReadEnvelope(env)));
  });

  test("params anchor the key attribution (authority-as-provenance), never the secret", () => {
    const d = slackReadDerivation(envFixture(), { now: 1000 });
    expect(d.manifest.params).toMatchObject({
      op: "history",
      keyId: "slack-k1-1000",
      scope: { ops: ["history"], channels: ["C1"] },
      expiresAt: 61_000,
    });
    expect(JSON.stringify(d.manifest.params)).not.toContain("xoxb");
  });
});

describe("recordSlackReadDerivation — ledger", () => {
  test("appends, is queryable, and links lineage from the query", async () => {
    const store = openAnchoredChain(":memory:");
    try {
      const env = envFixture();
      const d = await recordSlackReadDerivation(store.derivations, env, { now: 1000 });
      const fetched = await store.derivations.get(d.derivationId);
      expect(fetched?.derivationId).toBe(d.derivationId);

      const queryDigest = d.manifest.inputs.query!;
      const consumers = await store.invalidate.descendants(queryDigest);
      expect(consumers).toContain(d.derivationId);
    } finally {
      store.close();
    }
  });

  test("is idempotent — re-recording an identical read does not duplicate", async () => {
    const store = openAnchoredChain(":memory:");
    try {
      const env = envFixture();
      const first = await recordSlackReadDerivation(store.derivations, env, { now: 1000 });
      const second = await recordSlackReadDerivation(store.derivations, env, { now: 1000 });
      expect(second.derivationId).toBe(first.derivationId);
      const inputs = await store.derivations.listInputs(first.derivationId);
      expect(inputs).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("slackReadProvenance — SLSA projection", () => {
  test("projects onto a SLSA Provenance v1 in-toto Statement", () => {
    const env = envFixture();
    const stmt = slackReadProvenance(env, { now: 1000 });
    expect(stmt._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(stmt.predicateType).toBe(SLSA_PROVENANCE_PREDICATE_TYPE);
    expect(stmt.predicate.buildDefinition.buildType).toBe(SLACK_READ_BUILD_TYPE);
    expect(stmt.predicate.runDetails.builder.id).toBe(SLACK_READ_BUILDER_ID);
  });

  test("subject is the envelope, resolvedDependencies the query, params carry key attribution", () => {
    const env = envFixture();
    const stmt = slackReadProvenance(env, { now: 1000 });
    const d = slackReadDerivation(env, { now: 1000 });
    expect(stmt.subject[0]!.name).toBe("envelope");
    const envelopeDigest = d.manifest.outputs.envelope!;
    expect(stmt.subject[0]!.digest.sha256).toBe(
      (envelopeDigest as string).replace("sha256:", ""),
    );
    expect(stmt.predicate.buildDefinition.resolvedDependencies[0]!.name).toBe("query");
    expect(stmt.predicate.buildDefinition.externalParameters).toMatchObject({
      keyId: "slack-k1-1000",
    });
  });

  test("formats to a single JSON object + newline", () => {
    const out = formatSlackReadProvenanceJson(envFixture(), { now: 1000 });
    expect(out.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
