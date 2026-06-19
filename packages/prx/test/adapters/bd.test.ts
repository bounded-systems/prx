// GH-1645 — `BdDomainAdapter`: pin-zero UoW resolver via `BD-<8-hex>` surface.

import { describe, expect, test } from "bun:test";

import {
  adapterForCanonicalId,
  combinedCanonicalIdPattern,
} from "../../src/adapters/domain-adapter.ts";
import {
  BD_OWNED_ON_PULL,
  BD_SHORT_ID_PATTERN,
  BdDomainAdapter,
  BdDomainAdapterError,
  beadsDomainAdapter,
  ForeignWorkspacePrefixError,
} from "../../src/adapters/beads.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-1777747201085-737-407f177f",
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

describe("BdDomainAdapter — config / ownedOnPull pin", () => {
  test("config: domain bd, surfaceIdPattern /^BD-[0-9A-F]{8}$/, externalIdShape bd-long-id, empty ownedOnPull", () => {
    expect(beadsDomainAdapter.config.domain).toBe("bd");
    // The config's `surfaceIdPattern` is intentionally the short-id; the
    // wider GH-1658 long-id recognition lives in `matchesSurfaceId`.
    expect(beadsDomainAdapter.config.surfaceIdPattern.source).toBe("^BD-[0-9A-F]{8}$");
    expect(beadsDomainAdapter.config.externalIdShape).toBe("bd-long-id");
    // ADR §1 — bd is canonical for every bd-side field; pull is a no-op.
    expect(BD_OWNED_ON_PULL).toEqual([]);
    expect(beadsDomainAdapter.config.ownedOnPull).toEqual([]);
  });

  test("registered under domain 'bd' and resolvable by canonical id", () => {
    expect(adapterForCanonicalId("BD-407F177F")).toBe(beadsDomainAdapter);
  });

  test("BD_SHORT_ID_PATTERN matches the upper-cased 8-hex short form only", () => {
    expect(BD_SHORT_ID_PATTERN.test("BD-407F177F")).toBe(true);
    expect(BD_SHORT_ID_PATTERN.test("BD-407f177f")).toBe(false);
    expect(BD_SHORT_ID_PATTERN.test("BD-407F177")).toBe(false);
    expect(BD_SHORT_ID_PATTERN.test("BD-407F177FF")).toBe(false);
  });
});

describe("BdDomainAdapter.matchesSurfaceId / surfaceIdToExternalId", () => {
  const adapter = new BdDomainAdapter();

  test("matchesSurfaceId — short 8-hex form, case-insensitive via normalize", () => {
    expect(adapter.matchesSurfaceId("BD-407F177F")).toBe(true);
    expect(adapter.matchesSurfaceId(" bd-407f177f ")).toBe(true);
    // Workspace-prefixed long form is NOT the canonical short surface.
    expect(adapter.matchesSurfaceId("ai-home-1777747201085-737-407f177f")).toBe(false);
    // Garbage / other domains.
    expect(adapter.matchesSurfaceId("GH-1")).toBe(false);
    expect(adapter.matchesSurfaceId("NOTION-1")).toBe(false);
    expect(adapter.matchesSurfaceId("BD-")).toBe(false);
  });

  test("surfaceIdToExternalId — strips the BD- prefix and lowercases the 8-hex key", () => {
    expect(adapter.surfaceIdToExternalId("BD-407F177F")).toBe("407f177f");
    expect(adapter.surfaceIdToExternalId(" bd-407f177f ")).toBe("407f177f");
  });

  test("surfaceIdToExternalId — bd-side raw id (no BD- prefix) throws a typed adapter error", () => {
    // GH-1658: the long-id surface is now `BD-<prefix>-<tail>` (with the
    // `BD-` prefix). A bare bd-side `<prefix>-<tail>` is not a BD- surface
    // id and falls through to the generic adapter error.
    expect(() => adapter.surfaceIdToExternalId("ai-home-1777747201085-737-407f177f")).toThrow(
      BdDomainAdapterError,
    );
  });

  test("surfaceIdToExternalId — non-bd input throws a typed adapter error", () => {
    expect(() => adapter.surfaceIdToExternalId("GH-456")).toThrow(BdDomainAdapterError);
    expect(() => adapter.surfaceIdToExternalId("not-an-id")).toThrow(BdDomainAdapterError);
  });
});

describe("BdDomainAdapter.recognizesExternalId", () => {
  const adapter = new BdDomainAdapter();

  test("true for the 8-hex short tail and the workspace-prefixed long form", () => {
    expect(adapter.recognizesExternalId("407f177f")).toBe(true);
    expect(adapter.recognizesExternalId(" 407F177F ")).toBe(true);
    expect(adapter.recognizesExternalId("ai-home-1777747201085-737-407f177f")).toBe(true);
  });

  test("false for empty / non-hex / shapes from other domains", () => {
    expect(adapter.recognizesExternalId("")).toBe(false);
    expect(adapter.recognizesExternalId("BD-407F177F")).toBe(false);
    expect(adapter.recognizesExternalId("https://github.com/o/r/issues/1")).toBe(false);
    expect(adapter.recognizesExternalId("not-an-id")).toBe(false);
  });
});

describe("BdDomainAdapter.resolve / resolveFromBeads", () => {
  const beads: BeadsRecord[] = [
    bead({ id: "ai-home-1777747201085-737-407f177f" }),
    bead({ id: "ai-home-1777747197453-642-b5d5d951" }),
  ];

  test("exact 8-hex tail → bd record id (case-insensitive on the key)", () => {
    const a = new BdDomainAdapter();
    expect(a.resolveFromBeads("407f177f", beads)).toBe("ai-home-1777747201085-737-407f177f");
    expect(a.resolveFromBeads("407F177F", beads)).toBe("ai-home-1777747201085-737-407f177f");
  });

  test("`resolve` is the async sibling of `resolveFromBeads` — same dispatch contract", async () => {
    const a = new BdDomainAdapter({ loadAllBeads: () => beads });
    expect(await a.resolve("407f177f")).toBe("ai-home-1777747201085-737-407f177f");
  });

  test("never prefix-matches a bd long-id chunk", () => {
    const a = new BdDomainAdapter();
    expect(a.resolveFromBeads("ai-home", beads)).toBeNull();
    expect(a.resolveFromBeads("1777747201085", beads)).toBeNull();
  });

  test("no match → null", () => {
    const a = new BdDomainAdapter();
    expect(a.resolveFromBeads("deadbeef", beads)).toBeNull();
  });

  test("ambiguous match → null (caller surfaces the error)", () => {
    const dupes = [bead({ id: "ai-home-a-1-407f177f" }), bead({ id: "ai-home-b-2-407f177f" })];
    const a = new BdDomainAdapter();
    expect(a.resolveFromBeads("407f177f", dupes)).toBeNull();
  });

  test("empty / non-string input → null", () => {
    const a = new BdDomainAdapter();
    expect(a.resolveFromBeads("", beads)).toBeNull();
    expect(a.resolveFromBeads("   ", beads)).toBeNull();
    // `as unknown as string` to cover the runtime guard.
    expect(a.resolveFromBeads(null as unknown as string, beads)).toBeNull();
  });
});

describe("BdDomainAdapter.pull / push", () => {
  test("pull is a no-op — returns an empty patch", async () => {
    expect(await new BdDomainAdapter().pull("407f177f")).toEqual({});
  });

  test("push throws — bd is canonical for pin-zero UoWs", async () => {
    await expect(new BdDomainAdapter().push(bead(), { title: "anything" })).rejects.toThrow(
      BdDomainAdapterError,
    );
    await expect(new BdDomainAdapter().push(bead(), { title: "anything" })).rejects.toThrow(
      /bd is canonical|bd update/,
    );
  });
});

// GH-1658 — workspace-prefixed long-id arm: `BD-<prefix>-<ts>-<seq>-<hex8>`.
const LONG_ID = "BD-ai-home-1778515181936-7-edba9d4a";
const LONG_TAIL = "ai-home-1778515181936-7-edba9d4a";
const FOREIGN_LONG_ID = "BD-demo-repo-1778515181936-7-edba9d4a";

describe("BdDomainAdapter — long-id matchesSurfaceId (GH-1658)", () => {
  const adapter = new BdDomainAdapter();

  test("recognises BD-<prefix>-<ts>-<seq>-<hex8>", () => {
    expect(adapter.matchesSurfaceId(LONG_ID)).toBe(true);
  });

  test("still recognises the short-id arm (regression)", () => {
    expect(adapter.matchesSurfaceId("BD-407F177F")).toBe(true);
  });

  test("rejects malformed long-ids", () => {
    expect(adapter.matchesSurfaceId("BD-not-valid")).toBe(false);
    // Uppercase workspace prefix is not a valid bd workspace_prefix shape.
    expect(adapter.matchesSurfaceId("BD-AI-HOME-1778515181936-7-edba9d4a")).toBe(false);
    // Too-short timestamp.
    expect(adapter.matchesSurfaceId("BD-ai-home-12345-7-edba9d4a")).toBe(false);
    // Missing hex tail.
    expect(adapter.matchesSurfaceId("BD-ai-home-1778515181936-7-")).toBe(false);
  });
});

describe("BdDomainAdapter.surfaceIdToExternalId — long-id arm (GH-1658)", () => {
  test("local prefix match → returns the bare <prefix>-<tail>", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "ai-home",
    });
    expect(adapter.surfaceIdToExternalId(LONG_ID)).toBe(LONG_TAIL);
  });

  test("foreign prefix → throws ForeignWorkspacePrefixError with structured payload", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "ai-home",
    });
    let thrown: unknown = null;
    try {
      adapter.surfaceIdToExternalId(FOREIGN_LONG_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForeignWorkspacePrefixError);
    const err = thrown as ForeignWorkspacePrefixError;
    expect(err.surfaceId).toBe(FOREIGN_LONG_ID);
    expect(err.embeddedPrefix).toBe("demo-repo");
    expect(err.localPrefix).toBe("ai-home");
    expect(err.exitCode).toBe(2);
    // Pointer to the GH-1646 ADR / GH-1659 follow-up surfaces in the message.
    expect(err.message).toMatch(/GH-1659|cross-repo-bd-routing/);
  });

  test("local prefix is null (cwd outside any registered LocalRepo) → throws", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => null,
    });
    let thrown: unknown = null;
    try {
      adapter.surfaceIdToExternalId(LONG_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForeignWorkspacePrefixError);
    expect((thrown as ForeignWorkspacePrefixError).localPrefix).toBeNull();
    expect((thrown as ForeignWorkspacePrefixError).embeddedPrefix).toBe("ai-home");
  });

  test("repoCtx.cwd override is threaded to localWorkspacePrefix (not process.cwd)", () => {
    const seenCwds: string[] = [];
    const adapter = new BdDomainAdapter({
      cwd: () => "/should/not/be/used",
      localWorkspacePrefix: (cwd) => {
        seenCwds.push(cwd);
        return "ai-home";
      },
    });
    expect(adapter.surfaceIdToExternalId(LONG_ID, { cwd: "/different/path" })).toBe(LONG_TAIL);
    expect(seenCwds).toEqual(["/different/path"]);
  });

  test("no repoCtx → falls back to this.deps.cwd()", () => {
    const seenCwds: string[] = [];
    const adapter = new BdDomainAdapter({
      cwd: () => "/wired/cwd",
      localWorkspacePrefix: (cwd) => {
        seenCwds.push(cwd);
        return "ai-home";
      },
    });
    expect(adapter.surfaceIdToExternalId(LONG_ID)).toBe(LONG_TAIL);
    expect(seenCwds).toEqual(["/wired/cwd"]);
  });

  test("short-id arm does not consult localWorkspacePrefix", () => {
    let consulted = false;
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => {
        consulted = true;
        return null;
      },
    });
    expect(adapter.surfaceIdToExternalId("BD-407F177F")).toBe("407f177f");
    expect(consulted).toBe(false);
  });
});

describe("BdDomainAdapter.resolveFromBeads — long-id passthrough (GH-1658)", () => {
  const beads: BeadsRecord[] = [
    bead({ id: LONG_TAIL }),
    bead({ id: "ai-home-1777747197453-642-b5d5d951" }),
  ];

  test("resolves the bare <prefix>-<tail> against the bd snapshot via the existing hex-8 suffix scan", () => {
    const adapter = new BdDomainAdapter();
    expect(adapter.resolveFromBeads(LONG_TAIL, beads)).toBe(LONG_TAIL);
  });
});

describe("BdDomainAdapter — registry + canonical-pattern wiring (GH-1658)", () => {
  test("adapterForCanonicalId routes the long-id surface to beadsDomainAdapter", () => {
    expect(adapterForCanonicalId(LONG_ID)).toBe(beadsDomainAdapter);
  });

  test("combinedCanonicalIdPattern admits the long-id arm", () => {
    expect(combinedCanonicalIdPattern().test(LONG_ID)).toBe(true);
    expect(combinedCanonicalIdPattern().test(FOREIGN_LONG_ID)).toBe(true);
    // Short-id and other canonical surfaces still match.
    expect(combinedCanonicalIdPattern().test("BD-407F177F")).toBe(true);
    expect(combinedCanonicalIdPattern().test("GH-456")).toBe(true);
  });
});

// GH-1766 — bare workspace-long-id surface recognition. The third input form
// `prx plan session` accepts: a bd-native id (no `BD-` prefix) whose
// workspace prefix matches the cwd repo's registered `bd_workspace_prefix`.
describe("BdDomainAdapter — bare workspace-long-id arm (GH-1766)", () => {
  test("matchesSurfaceId — bare id whose prefix matches local workspace", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "demo-repo",
    });
    expect(adapter.matchesSurfaceId("demo-repo-pin.9.4.2")).toBe(true);
    expect(adapter.matchesSurfaceId("demo-repo-1778515181936-7-edba9d4a")).toBe(true);
  });

  test("matchesSurfaceId — bare id with non-matching prefix is rejected", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "ai-home",
    });
    expect(adapter.matchesSurfaceId("demo-repo-pin.9.4.2")).toBe(false);
  });

  test("surfaceIdToExternalId — bare id passes through verbatim", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "demo-repo",
    });
    expect(adapter.surfaceIdToExternalId("demo-repo-pin.9.4.2")).toBe("demo-repo-pin.9.4.2");
  });

  test("surfaceIdToExternalId — bare id with foreign prefix throws", () => {
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: () => "ai-home",
    });
    expect(() => adapter.surfaceIdToExternalId("demo-repo-pin.9.4.2")).toThrow(
      BdDomainAdapterError,
    );
  });
});

// GH-1766 — exact-id fallback for semantic-id workspaces (no hex8 tail).
describe("BdDomainAdapter.resolveFromBeads — semantic-id fallback (GH-1766)", () => {
  const beads: BeadsRecord[] = [
    bead({ id: "demo-repo-pin.9.4.2" }),
    bead({ id: "demo-repo-pin.9.4.3" }),
    bead({ id: "ai-home-1777747201085-737-407f177f" }),
  ];

  test("exact id match — semantic-id workspaces resolve via the new fallback", () => {
    const adapter = new BdDomainAdapter();
    expect(adapter.resolveFromBeads("demo-repo-pin.9.4.2", beads)).toBe("demo-repo-pin.9.4.2");
  });

  test("exact-id fallback does not mask the hex8-suffix scan", () => {
    const adapter = new BdDomainAdapter();
    expect(adapter.resolveFromBeads("407f177f", beads)).toBe("ai-home-1777747201085-737-407f177f");
  });
});
