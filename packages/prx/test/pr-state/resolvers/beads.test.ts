// GH-1766 — BeadsResolver: hydrate path for canonical=bd plan sessions.

import { describe, expect, test } from "bun:test";

import { BeadsResolver } from "../../../src/pr-state/resolvers/beads.ts";
import type { BdShowResult } from "@bounded-systems/bd";
import type { BeadsRecord } from "../../../src/triage/triage.ts";

const longId = "ai-home-1777747201085-737-407f177f";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: longId,
    title: "fixture",
    description: "fixture body",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function showOk(record: BeadsRecord): BdShowResult {
  return {
    ok: true,
    record: {
      id: record.id,
      title: record.title,
      description: record.description,
      status: record.status,
      priority: record.priority,
      issueType: record.issueType,
    },
    stdout: "",
    stderr: "",
  };
}

describe("BeadsResolver.fetch", () => {
  test("BD-<8hex> input resolves via the snapshot, hydrates open record", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [bead()],
      bdShow: (id) => {
        expect(id).toBe(longId);
        return showOk(bead());
      },
    });
    const resolved = await resolver.fetch("BD-407F177F");
    expect(resolved).toEqual({
      id: "BD-407F177F",
      title: "fixture",
      body: "fixture body",
      state: "open",
      url: null,
      source: "beads",
    });
  });

  test("closed bd record surfaces as state=closed", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [bead({ status: "closed" })],
      bdShow: () => showOk(bead({ status: "closed" })),
    });
    const resolved = await resolver.fetch("BD-407F177F");
    expect(resolved.state).toBe("closed");
  });

  test("name = 'beads' so dispatch and parity-chain branches can fork on source", () => {
    const resolver = new BeadsResolver("/tmp/repo");
    expect(resolver.name).toBe("beads");
  });

  test("toBdLongId — BD-<8hex> short form resolves through the snapshot", () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [bead()],
      bdShow: () => showOk(bead()),
    });
    expect(resolver.toBdLongId("BD-407F177F")).toBe(longId);
  });

  test("toBdLongId — BD-<workspace>-<tail> long form delegates to the adapter", () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [],
      bdShow: () => showOk(bead()),
    });
    // The covering BdDomainAdapter consults process.cwd() for the local
    // workspace prefix; for this synthetic test we accept the foreign-prefix
    // throw and just verify the dispatch reaches the adapter path.
    expect(() => resolver.toBdLongId("BD-foreign-prefix-1778515181936-7-edba9d4a")).toThrow();
  });

  test("toBdLongId — bare bd-native long id passes through verbatim", () => {
    const resolver = new BeadsResolver("/tmp/repo");
    expect(resolver.toBdLongId(longId)).toBe(longId);
  });

  test("missing bd record (snapshot empty) → BeadsResolverError", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [],
      bdShow: () => showOk(bead()),
    });
    await expect(resolver.fetch("BD-deadbeef")).rejects.toThrow(
      /bd record not found/,
    );
  });

  test("bd show non-zero exit → BeadsResolverError", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [bead()],
      bdShow: () => ({
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "boom",
      }),
    });
    await expect(resolver.fetch("BD-407F177F")).rejects.toThrow(/bd show .* exit 2/);
  });

  // GH-852: external_ref lookup arm — non-BD canonical ids resolve via
  // `externalRefs[<prefix>]` rather than the surface-id snapshot scan.
  test("external_ref hit — PROJ-5743 resolves through externalRefs[proj]", async () => {
    const tagged = bead({
      externalRefs: { proj: "proj-5743" },
    });
    const resolver = new BeadsResolver("/tmp/repo", {
      externalRefPrefix: "proj",
      loadAllBeads: () => [bead({ id: "other", externalRefs: { proj: "proj-1" } }), tagged],
      bdShow: (id) => {
        expect(id).toBe(longId);
        return showOk(tagged);
      },
    });
    const resolved = await resolver.fetch("PROJ-5743");
    expect(resolved).toEqual({
      id: "PROJ-5743",
      title: "fixture",
      body: "fixture body",
      state: "open",
      url: null,
      source: "beads",
    });
  });

  // Legacy bd records pin a single GH issue URL in `external_ref` instead of
  // the per-domain `externalRefs` map (pre-GH-1538 records). The lookup
  // falls back to that slot when the prefix-keyed map slot is empty.
  test("external_ref hit — falls back to legacy single externalRef slot", async () => {
    const tagged = bead({ externalRef: "proj-5743", externalRefs: {} });
    const resolver = new BeadsResolver("/tmp/repo", {
      externalRefPrefix: "proj",
      loadAllBeads: () => [tagged],
      bdShow: () => showOk(tagged),
    });
    const resolved = await resolver.fetch("PROJ-5743");
    expect(resolved.id).toBe("PROJ-5743");
    expect(resolved.source).toBe("beads");
  });

  test("external_ref miss — empty snapshot throws structured error", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      externalRefPrefix: "proj",
      loadAllBeads: () => [],
      bdShow: () => showOk(bead()),
    });
    await expect(resolver.fetch("PROJ-5743")).rejects.toThrow(
      /no bd row with external_ref proj-5743 in \/tmp\/repo/,
    );
  });

  test("external_ref miss — prefix mismatch is also a miss", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      externalRefPrefix: "proj",
      // Row carries a `product` external-ref, not the configured `proj`
      // domain — the registry walk landed on proj-beads, so this row
      // should not satisfy the lookup.
      loadAllBeads: () => [bead({ externalRefs: { product: "product-5743" } })],
      bdShow: () => showOk(bead()),
    });
    await expect(resolver.fetch("PROJ-5743")).rejects.toThrow(
      /no bd row with external_ref proj-5743/,
    );
  });

  test("no external_ref_prefix configured — non-BD canonical id is a structured error", async () => {
    const resolver = new BeadsResolver("/tmp/repo", {
      loadAllBeads: () => [bead({ externalRefs: { proj: "proj-5743" } })],
      bdShow: () => showOk(bead()),
    });
    await expect(resolver.fetch("PROJ-5743")).rejects.toThrow(
      /no external_ref_prefix configured/,
    );
  });
});
