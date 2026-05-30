import { afterEach, describe, expect, test } from "bun:test";

// Side-effect imports: every prx-default `DomainAdapter` self-registers on
// import. Loading them here makes the canonical-id assertions below
// deterministic regardless of which other test files happen to be in the same
// worker (the adapter registry is process-wide). Mirrors the side-effect
// import shape `src/sync/run.ts` and other production callers use via the
// `src/adapters/index.ts` barrel.
import "../../src/adapters/github.ts";
import "../../src/adapters/notion.ts";
import "../../src/adapters/beads.ts";

import {
  __unregisterDomainAdapterForTesting,
  adapterForCanonicalId,
  adapterForDomain,
  BaseDomainAdapter,
  canonicalIdPatternForIdentity,
  combinedCanonicalIdPattern,
  domainAdapterConfigSchema,
  GH_SURFACE_ID_PATTERN,
  NOTION_SURFACE_ID_PATTERN,
  registerDomainAdapter,
  registeredDomains,
  type AdapterIoOpts,
  type DomainAdapter,
  type DomainAdapterConfigInput,
  type DomainPushFields,
  type DomainPushResult,
  type ExternalRecordRef,
  type ResolvedWorkUnitPatch,
} from "../../src/adapters/domain-adapter.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

// The canonical-id union prx ships with by default: baseline GH + Notion
// shapes plus the registry-contributed `BD-<8-hex>` short-id arm and the
// workspace-prefixed `BD-<prefix>-<ts>-<seq>-<hex8>` long-id arm from
// `beads.ts` (GH-1645, GH-1658). `loadIdentityConfig`'s `isDefault` check
// compares the user's pinned `canonical_id_pattern` against this `.source`
// byte-for-byte — drift here silently turns every default repo into a
// "custom identity", which would change canonical-id resolution. Update in
// lock-step with `test/machine/work_unit.test.ts` LEGACY_CANONICAL_ID_SOURCE.
const LEGACY_CANONICAL_ID_SOURCE =
  /^(GH-\d+|NOTION-([0-9a-fA-F]{32}|\d+)|BD-[0-9A-F]{8}|BD-[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8})$/.source;

class FakeAdapter extends BaseDomainAdapter {
  constructor(config: DomainAdapterConfigInput) {
    super(config);
  }
  recognizesExternalId(_externalId: string): boolean {
    return false;
  }
  surfaceIdToExternalId(id: string): string {
    return `ext:${id}`;
  }
  async pull(_externalId: string, _opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
    return {};
  }
  async push(
    _bd: BeadsRecord,
    _fields: DomainPushFields,
    _opts?: AdapterIoOpts,
  ): Promise<DomainPushResult> {
    return { externalId: "ext", created: false, edited: false };
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

function jiraAdapter(): DomainAdapter {
  return new FakeAdapter({
    domain: "jira",
    surfaceIdPattern: /^PROJ-\d+$/,
    externalIdShape: "key-n",
    ownedOnPull: ["status"],
  });
}

describe("domainAdapterConfigSchema", () => {
  test("parses a string surfaceIdPattern into a RegExp and accepts a RegExp directly", () => {
    const fromString = domainAdapterConfigSchema.parse({
      domain: "gh",
      surfaceIdPattern: "^GH-\\d+$",
      externalIdShape: "issue-url",
      ownedOnPull: ["status"],
    });
    expect(fromString.surfaceIdPattern).toBeInstanceOf(RegExp);
    expect(fromString.surfaceIdPattern.test("GH-7")).toBe(true);

    const fromRegExp = domainAdapterConfigSchema.parse({
      domain: "gh",
      surfaceIdPattern: /^GH-\d+$/,
      externalIdShape: "issue-url",
      ownedOnPull: ["status"],
    });
    expect(fromRegExp.surfaceIdPattern.source).toBe("^GH-\\d+$");
  });

  test("rejects an uppercase domain prefix", () => {
    expect(() =>
      domainAdapterConfigSchema.parse({
        domain: "GH",
        surfaceIdPattern: /^GH-\d+$/,
        externalIdShape: "issue-url",
        ownedOnPull: [],
      }),
    ).toThrow(/lowercase prefix/i);
  });

  test("rejects an unknown externalIdShape", () => {
    expect(() =>
      domainAdapterConfigSchema.parse({
        domain: "gh",
        surfaceIdPattern: /^GH-\d+$/,
        externalIdShape: "made-up",
        ownedOnPull: [],
      }),
    ).toThrow();
  });

  test("rejects an unparseable surfaceIdPattern string", () => {
    expect(() =>
      domainAdapterConfigSchema.parse({
        domain: "gh",
        surfaceIdPattern: "([",
        externalIdShape: "issue-url",
        ownedOnPull: [],
      }),
    ).toThrow(/not a valid regex/i);
  });
});

describe("registry", () => {
  afterEach(() => __unregisterDomainAdapterForTesting("jira"));

  test("register / lookup by domain and by canonical id; validated + frozen config", () => {
    const adapter = registerDomainAdapter(jiraAdapter());
    expect(adapterForDomain("jira")).toBe(adapter);
    expect(adapterForCanonicalId("PROJ-42")).toBe(adapter);
    expect(adapterForCanonicalId("ZZZ-42")).toBeNull();
    expect(adapter.config.surfaceIdPattern).toBeInstanceOf(RegExp);
    expect(Object.isFrozen(adapter.config)).toBe(true);
    expect(() => {
      (adapter.config as Record<string, unknown>).domain = "other";
    }).toThrow();
    expect(registeredDomains()).toContain("jira");
  });

  test("registering the same domain twice replaces the prior entry", () => {
    const first = registerDomainAdapter(jiraAdapter());
    const second = registerDomainAdapter(jiraAdapter());
    expect(adapterForDomain("jira")).toBe(second);
    expect(adapterForDomain("jira")).not.toBe(first);
  });

  test("malformed adapter config is rejected at registration", () => {
    expect(() =>
      registerDomainAdapter(
        new FakeAdapter({
          domain: "BAD",
          surfaceIdPattern: /^X-\d+$/,
          externalIdShape: "key-n",
          ownedOnPull: [],
        }),
      ),
    ).toThrow(/lowercase prefix/i);
  });
});

describe("combinedCanonicalIdPattern", () => {
  afterEach(() => __unregisterDomainAdapterForTesting("jira"));

  test("prx-default registry reproduces the GH/NOTION/BD canonical-id literal source", () => {
    expect(combinedCanonicalIdPattern().source).toBe(LEGACY_CANONICAL_ID_SOURCE);
    expect(combinedCanonicalIdPattern().test("GH-456")).toBe(true);
    expect(
      combinedCanonicalIdPattern().test("NOTION-0123456789abcdef0123456789abcdef"),
    ).toBe(true);
    expect(combinedCanonicalIdPattern().test("NOTION-123")).toBe(true);
    expect(combinedCanonicalIdPattern().test("BD-407F177F")).toBe(true);
    expect(combinedCanonicalIdPattern().test("PROJ-9")).toBe(false);
  });

  test("registering an extra domain widens the union", () => {
    registerDomainAdapter(jiraAdapter());
    const pattern = combinedCanonicalIdPattern();
    expect(pattern.test("GH-456")).toBe(true);
    expect(pattern.test("NOTION-123")).toBe(true);
    expect(pattern.test("PROJ-9")).toBe(true);
  });
});

describe("canonicalIdPatternForIdentity", () => {
  test("default identity → registry-derived union; custom pattern wins outright", () => {
    expect(
      canonicalIdPatternForIdentity({
        canonicalIdPattern: combinedCanonicalIdPattern(),
        isDefault: true,
      }).source,
    ).toBe(LEGACY_CANONICAL_ID_SOURCE);

    const custom = /^ACME-\d+$/;
    expect(
      canonicalIdPatternForIdentity({ canonicalIdPattern: custom, isDefault: false }),
    ).toBe(custom);
  });
});

describe("baseline surface-id patterns", () => {
  test("exported GH/Notion patterns are anchored", () => {
    expect(GH_SURFACE_ID_PATTERN.test("GH-1")).toBe(true);
    expect(GH_SURFACE_ID_PATTERN.test("xGH-1")).toBe(false);
    expect(NOTION_SURFACE_ID_PATTERN.test("NOTION-1")).toBe(true);
    expect(NOTION_SURFACE_ID_PATTERN.test("NOTION-zzz")).toBe(false);
  });
});
