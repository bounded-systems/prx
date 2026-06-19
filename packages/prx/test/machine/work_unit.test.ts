// GH-1538 — `resolveUoW` dispatch + canonical-id pattern regression.

import { describe, expect, test } from "bun:test";

// Side-effect imports: register the GH and BD adapters so
// `adapterForCanonicalId` resolves their canonical ids. The test file is read
// in isolation by some runners; without these imports the registry would be
// empty and the canonical-id union (`canonicalWorkUnitIdPattern`) would not
// include the adapter-driven `BD-<8-hex>` arm.
import "../../src/adapters/github.ts";
import "../../src/adapters/beads.ts";

import {
  __unregisterDomainAdapterForTesting,
  BaseDomainAdapter,
  canonicalIdPatternForIdentity,
  registerDomainAdapter,
  type AdapterIoOpts,
  type DomainPushFields,
  type DomainPushResult,
  type ExternalRecordRef,
  type ResolvedWorkUnitPatch,
} from "../../src/adapters/domain-adapter.ts";
import {
  canonicalWorkUnitIdPattern,
  parseCanonicalWorkUnitId,
  resolveUoW,
} from "../../src/machine/work_unit.ts";
import { BdDomainAdapter, beadsDomainAdapter } from "../../src/adapters/beads.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

// The canonical-id union prx ships with by default — baseline GH + Notion
// shapes, the `BD-<8-hex>` short-id arm contributed by the BD adapter
// (GH-1645), and the workspace-prefixed `BD-<prefix>-<ts>-<seq>-<hex8>`
// long-id arm (GH-1658). `loadIdentityConfig`'s `isDefault` check compares
// the user's pinned `canonical_id_pattern` against
// `canonicalWorkUnitIdPattern.source` byte-for-byte — drift here silently
// turns every default repo into a "custom identity", which would change
// canonical-id resolution. Do not change this constant without auditing
// `isDefault`.
const LEGACY_CANONICAL_ID_SOURCE =
  "^(GH-\\d+|NOTION-([0-9a-fA-F]{32}|\\d+)|BD-[0-9A-F]{8}|BD-[a-z][a-z0-9-]*-\\d{13,}-\\d+-[0-9a-f]{8})$";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-fixture",
    title: "fixture",
    description: "",
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

class StubAdapter extends BaseDomainAdapter {
  constructor() {
    super({
      domain: "stub",
      surfaceIdPattern: /^STUB-\d+$/,
      externalIdShape: "key-n",
      ownedOnPull: [],
    });
  }
  recognizesExternalId(_externalId: string): boolean {
    return false;
  }
  surfaceIdToExternalId(id: string): string {
    return `stub:${id}`;
  }
  async pull(_externalId: string, _opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
    return {};
  }
  async push(
    _bd: BeadsRecord,
    _fields: DomainPushFields,
    _opts?: AdapterIoOpts,
  ): Promise<DomainPushResult> {
    return { externalId: "stub:x", created: false, edited: false };
  }
  async enumerate(): Promise<ExternalRecordRef[]> {
    return [];
  }
  async resolve(_externalId: string): Promise<string | null> {
    return null;
  }
  resolveFromBeads(_externalId: string, _beads: BeadsRecord[]): string | null {
    return null;
  }
}

describe("canonicalWorkUnitIdPattern — regression", () => {
  test("`canonicalWorkUnitIdPattern.source` matches the legacy literal byte-for-byte", () => {
    // This is the load-bearing invariant `loadIdentityConfig`'s `isDefault`
    // guard relies on. If you change `combinedCanonicalIdPattern`, this test
    // is the canary — and so is `src/pr-state/github.ts:3729`. Update both.
    expect(canonicalWorkUnitIdPattern.source).toBe(LEGACY_CANONICAL_ID_SOURCE);
  });

  test("registering a new adapter widens the union; `canonicalIdPatternForIdentity` reflects the widened pattern under default identity", () => {
    try {
      registerDomainAdapter(new StubAdapter());
      const widened = canonicalIdPatternForIdentity({
        canonicalIdPattern: canonicalWorkUnitIdPattern,
        isDefault: true,
      });
      expect(widened.test("GH-1538")).toBe(true);
      expect(widened.test("STUB-7")).toBe(true);
      expect(widened.source).not.toBe(LEGACY_CANONICAL_ID_SOURCE);
    } finally {
      __unregisterDomainAdapterForTesting("stub");
    }
  });
});

describe("parseCanonicalWorkUnitId — case preservation across arms (GH-1674)", () => {
  // The seam used to do `trim().toUpperCase()` unconditionally before testing
  // against the canonical-id union. That silently nulled out every arm of
  // `combinedCanonicalIdPattern()` whose character classes are lowercase-only
  // — most importantly the BD long-id arm
  // (`BD-[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8}`, GH-1658). Verbatim-first,
  // case-folded fallback restores the doctrine that the pattern (not the
  // seam) decides which arms are case-sensitive.

  test("GH baseline canonical: verbatim unchanged", () => {
    expect(parseCanonicalWorkUnitId("GH-1538") as string | null).toBe("GH-1538");
  });

  test("GH baseline canonical: lowercase via case-folded fallback", () => {
    expect(parseCanonicalWorkUnitId("gh-1538") as string | null).toBe("GH-1538");
  });

  test("GH baseline canonical: trim + verbatim", () => {
    expect(parseCanonicalWorkUnitId(" GH-1538 ") as string | null).toBe("GH-1538");
  });

  test("BD short-id: verbatim uppercase preserved", () => {
    expect(parseCanonicalWorkUnitId("BD-407F177F") as string | null).toBe("BD-407F177F");
  });

  test("BD short-id: lowercase via case-folded fallback", () => {
    expect(parseCanonicalWorkUnitId("bd-407f177f") as string | null).toBe("BD-407F177F");
  });

  test("BD long-id: lowercase verbatim preserved (THE FIX)", () => {
    expect(parseCanonicalWorkUnitId("BD-ai-home-1777747201085-737-407f177f") as string | null).toBe(
      "BD-ai-home-1777747201085-737-407f177f",
    );
  });

  test("BD long-id: uppercase form rejected (arm is structurally lowercase-only)", () => {
    expect(parseCanonicalWorkUnitId("BD-AI-HOME-1777747201085-737-407F177F")).toBeNull();
  });

  test("NOTION 32-hex: verbatim lowercase preserved", () => {
    expect(
      parseCanonicalWorkUnitId("NOTION-0123456789abcdef0123456789abcdef") as string | null,
    ).toBe("NOTION-0123456789abcdef0123456789abcdef");
  });

  test("empty / bare workspace-long-id / garbage all return null", () => {
    expect(parseCanonicalWorkUnitId("")).toBeNull();
    expect(parseCanonicalWorkUnitId("   ")).toBeNull();
    // Bare bd long-id (no `BD-` prefix) is not a canonical surface id.
    expect(parseCanonicalWorkUnitId("ai-home-1777747201085-737-407f177f")).toBeNull();
    expect(parseCanonicalWorkUnitId("¯\\_(ツ)_/¯")).toBeNull();
    expect(parseCanonicalWorkUnitId(null)).toBeNull();
    expect(parseCanonicalWorkUnitId(undefined)).toBeNull();
  });
});

describe("resolveUoW — GH dispatch via the GitHub adapter", () => {
  const beads: BeadsRecord[] = [
    bead({
      id: "ai-home-target",
      externalRef: "https://github.com/o/r/issues/1538",
      externalRefs: { gh: "https://github.com/o/r/issues/1538" },
      externalIssueNumber: 1538,
    }),
    bead({
      id: "ai-home-other",
      externalRef: "https://github.com/o/r/issues/42",
      externalRefs: { gh: "https://github.com/o/r/issues/42" },
      externalIssueNumber: 42,
    }),
  ];

  test("resolves `GH-1538` to its mirrored bd short-id", () => {
    expect(resolveUoW("GH-1538", beads, { repo: "o/r" })).toBe("ai-home-target");
  });

  test("accepts lowercase / whitespace-padded canonical input via the parser", () => {
    expect(resolveUoW(" gh-1538 ", beads, { repo: "o/r" })).toBe("ai-home-target");
  });

  test("returns null when no bead mirrors the surface id", () => {
    expect(resolveUoW("GH-9999", beads, { repo: "o/r" })).toBeNull();
  });

  test("returns null on a non-canonical surface id (never short-id prefix matching)", () => {
    expect(resolveUoW("ai-home-target", beads, { repo: "o/r" })).toBeNull();
    expect(resolveUoW("not-an-id", beads)).toBeNull();
  });

  test("returns null when no adapter is registered for the surface id's domain", () => {
    // NOTION-… matches the *baseline* surface-id pattern (it is recognised
    // canonical), but no Notion adapter is registered → no resolver path.
    expect(resolveUoW("NOTION-0123456789abcdef0123456789abcdef", beads)).toBeNull();
  });
});

describe("resolveUoW — BD dispatch via the BdDomainAdapter", () => {
  // Pin-zero bd record (no external domain pinned) — the GH-1645 case
  // `BD-<8-hex>` exists to address.
  const beads: BeadsRecord[] = [
    bead({ id: "ai-home-1777747201085-737-407f177f", externalRef: null }),
  ];

  test("resolves `BD-407F177F` to its bd record id", () => {
    expect(resolveUoW("BD-407F177F", beads)).toBe("ai-home-1777747201085-737-407f177f");
  });

  test("accepts lowercase / whitespace-padded canonical input via the parser", () => {
    expect(resolveUoW(" bd-407f177f ", beads)).toBe("ai-home-1777747201085-737-407f177f");
  });

  test("no bd record matches the 8-hex tail → null", () => {
    expect(resolveUoW("BD-DEADBEEF", beads)).toBeNull();
  });

  test("workspace-prefixed long bd id is not a canonical surface id → null", () => {
    // The bare bd long-id (no `BD-` prefix) is not a canonical surface id;
    // it doesn't match any arm of `canonicalWorkUnitIdPattern`. The
    // surface-prefixed form (`BD-ai-home-…`) IS canonical and dispatches
    // through the long-id arm — see the GH-1674 case-preservation test
    // below. Long-id cross-repo routing for foreign prefixes is GH-1658 /
    // GH-1659.
    expect(resolveUoW("ai-home-1777747201085-737-407f177f", beads)).toBeNull();
  });
});

describe("resolveUoW — BD long-id dispatch via the BdDomainAdapter (GH-1674)", () => {
  // GH-1674 lifts the seam-level case-loss that previously nulled out the
  // long-id arm before the adapter ever saw it. We stub the adapter's deps
  // (`cwd` + `localWorkspacePrefix`) so the test stays hermetic — no read of
  // `.prx/repos/index.json`. The bd record id is the bare long-id (no `BD-`
  // prefix), matching the adapter's `endsWith("-<hex8>")` lookup tail.

  const beads: BeadsRecord[] = [
    bead({ id: "ai-home-1777747201085-737-407f177f", externalRef: null }),
  ];

  test("`BD-<prefix>-<ts>-<seq>-<hex8>` dispatches to the bd record id", () => {
    // Swap in a stubbed adapter for the duration of the test, then restore
    // the production `beadsDomainAdapter` singleton so other test files that
    // assert `adapterForCanonicalId(...) === beadsDomainAdapter` by identity
    // (e.g. `test/adapters/bd.test.ts`) keep seeing the original.
    try {
      registerDomainAdapter(
        new BdDomainAdapter({
          cwd: () => "/fixture",
          localWorkspacePrefix: () => "ai-home",
        }),
      );
      expect(resolveUoW("BD-ai-home-1777747201085-737-407f177f", beads, { cwd: "/fixture" })).toBe(
        "ai-home-1777747201085-737-407f177f",
      );
    } finally {
      registerDomainAdapter(beadsDomainAdapter);
    }
  });
});

describe("resolveUoW — adapter dispatch boundary", () => {
  // `resolveUoW` validates the input against the *static*
  // `canonicalWorkUnitIdPattern` (the union computed at module init), so
  // dispatch is bounded to whatever adapters were registered at that point.
  // The GH path above already pins dispatch end-to-end; the cases below pin
  // the boundary semantics within that static frame.

  test("garbage input → null (no adapter, no canonical id)", () => {
    expect(resolveUoW("¯\\_(ツ)_/¯", [])).toBeNull();
    expect(resolveUoW("", [])).toBeNull();
  });

  test("canonical id of an unregistered domain → null (no Notion adapter today)", () => {
    expect(resolveUoW("NOTION-1", [])).toBeNull();
  });
});
