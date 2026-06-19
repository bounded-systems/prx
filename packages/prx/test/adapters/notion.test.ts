import { describe, expect, test } from "bun:test";

import {
  adapterForCanonicalId,
  NOTION_SURFACE_ID_PATTERN,
} from "../../src/adapters/domain-adapter.ts";
import {
  NotionDomainAdapter,
  NotionDomainAdapterError,
  NOTION_OWNED_ON_PULL,
  notionDomainAdapter,
  type NotionDomainAdapterDeps,
} from "../../src/adapters/notion.ts";
import type { IdentityConfig, NotionIdentityConfig } from "../../src/pr-state/github.ts";
import type {
  NotionPageResolver,
  WorkUnitResolver,
  ResolvedWorkUnit,
} from "../../src/pr-state/resolvers/types.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";
import type { BeadsRecord } from "../../src/triage/triage.ts";

const REST_CFG: NotionIdentityConfig = {
  auth: "rest",
  databaseId: "db-abc",
  idProperty: "Internal ID",
  titleProperty: "Name",
  statusProperty: "Status",
  tokenOpRef: null,
};

const IDENTITY = (cfg: NotionIdentityConfig): IdentityConfig => ({
  sources: {
    notion: {
      name: "notion",
      kind: "notion",
      canonicalIdPattern: /^GH-\d+$/,
      source: "<test>",
      notion: cfg,
    },
  },
  defaultSourceName: "notion",
  isDefault: true,
});

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-x",
    title: "My issue",
    description: "body text",
    status: "open",
    priority: 1,
    issueType: "bug",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function recordingBdExec(
  result: BdExecResult = { exitCode: 0, stdout: "", stderr: "", policy: null },
): {
  exec: (opts: BdExecOptions) => BdExecResult;
  run: (
    cmd: string[],
    o?: { cwd?: string; check?: boolean },
  ) => { status: number; stdout: string; stderr: string };
  calls: BdExecOptions[];
} {
  const calls: BdExecOptions[] = [];
  return {
    exec: (opts: BdExecOptions) => {
      calls.push(opts);
      return result;
    },
    // GH-296 / prx-82b: writes now run `prx beads update …` through the daemon (a
    // sync runner). Record the equivalent old BdExecOptions shape so assertions hold.
    run: (cmd: string[], o?: { cwd?: string; check?: boolean }) => {
      calls.push({
        subcommand: cmd[2] ?? "",
        args: cmd.slice(3),
        ...(o?.cwd !== undefined ? { cwd: o.cwd } : {}),
        state: "planning",
        role: "planner",
      } as BdExecOptions);
      return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    calls,
  };
}

type FetchCall = { url: string; init: RequestInit | undefined };

function recordingFetch(responder: (call: FetchCall) => Response): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    return responder(call);
  };
  // Bun's `typeof fetch` includes a `preconnect` static — stub it.
  (impl as unknown as { preconnect: (...args: unknown[]) => void }).preconnect = () => {};
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeResolver(unit: Partial<ResolvedWorkUnit> = {}): NotionPageResolver {
  const resolved: ResolvedWorkUnit = {
    id: "uuid",
    title: "t",
    body: null,
    state: "open",
    url: null,
    source: "notion",
    ...unit,
  };
  return {
    name: "notion",
    fetch: async () => resolved,
    findPageId: async () => ({ pageId: resolved.id, pageUrl: null }),
    fetchByPageId: async () => resolved,
  };
}

function fakeCliResolver(unit: Partial<ResolvedWorkUnit> = {}): WorkUnitResolver {
  const resolved: ResolvedWorkUnit = {
    id: "uuid",
    title: "t",
    body: null,
    state: "unknown",
    url: null,
    source: "notion",
    ...unit,
  };
  return {
    name: "notion",
    fetch: async () => resolved,
  };
}

function makeAdapter(over: NotionDomainAdapterDeps = {}): NotionDomainAdapter {
  return new NotionDomainAdapter({
    cwd: () => "/repo",
    env: { NOTION_TOKEN: "tok" },
    loadIdentityConfig: () => IDENTITY(REST_CFG),
    ...over,
  });
}

// ── config + registration ──────────────────────────────────────────────────

describe("NotionDomainAdapter — config / ownedOnPull pin", () => {
  test("ADR §2 Notion column is the literal ownedOnPull declaration", () => {
    expect(NOTION_OWNED_ON_PULL).toEqual(["status"]);
    expect(notionDomainAdapter.config.ownedOnPull).toEqual(["status"]);
  });

  test("config: domain notion, surfaceIdPattern matches NOTION_SURFACE_ID_PATTERN, externalIdShape page-uuid", () => {
    expect(notionDomainAdapter.config.domain).toBe("notion");
    expect(notionDomainAdapter.config.surfaceIdPattern.source).toBe(
      NOTION_SURFACE_ID_PATTERN.source,
    );
    expect(notionDomainAdapter.config.externalIdShape).toBe("page-uuid");
  });

  test("registered under domain 'notion' and resolvable by canonical id", () => {
    const adapter = adapterForCanonicalId("NOTION-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(adapter?.config.domain).toBe("notion");
  });
});

// ── surface-id helpers ─────────────────────────────────────────────────────

describe("NotionDomainAdapter — id helpers", () => {
  const adapter = makeAdapter();

  test("matchesSurfaceId / surfaceIdToExternalId", () => {
    expect(adapter.matchesSurfaceId("NOTION-12345678901234567890123456789012")).toBe(true);
    expect(adapter.matchesSurfaceId("NOTION-42")).toBe(true);
    expect(adapter.matchesSurfaceId("GH-1")).toBe(false);
    expect(adapter.matchesSurfaceId("notion-1")).toBe(false);
    expect(adapter.surfaceIdToExternalId("NOTION-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(() => adapter.surfaceIdToExternalId("GH-1")).toThrow(NotionDomainAdapterError);
  });

  test("recognizesExternalId: true for 32-hex Notion UUIDs (with/without dashes), false otherwise", () => {
    expect(adapter.recognizesExternalId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(adapter.recognizesExternalId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(true);
    expect(adapter.recognizesExternalId("https://github.com/o/r/issues/1")).toBe(false);
    expect(adapter.recognizesExternalId("NOTION-42")).toBe(false);
    expect(adapter.recognizesExternalId("")).toBe(false);
  });
});

// ── pull — auth dispatch ──────────────────────────────────────────────────

describe("NotionDomainAdapter.pull — auth dispatch", () => {
  test("auth = rest → uses REST resolver's fetchByPageId; maps state → status", async () => {
    let restCalls = 0;
    const adapter = makeAdapter({
      createRestResolver: () => {
        restCalls += 1;
        return fakeResolver({ state: "closed" });
      },
    });
    const patch = await adapter.pull("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(restCalls).toBe(1);
    expect(patch).toEqual({ status: "closed" });
  });

  test("auth = claude-mcp → uses claude-mcp resolver; maps unknown state to 'unknown'", async () => {
    const claudeCfg: NotionIdentityConfig = { ...REST_CFG, auth: "claude-mcp" };
    let mcpCalls = 0;
    const adapter = makeAdapter({
      loadIdentityConfig: () => IDENTITY(claudeCfg),
      createClaudeMcpResolver: () => {
        mcpCalls += 1;
        return fakeResolver({ state: "unknown" });
      },
    });
    const patch = await adapter.pull("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(mcpCalls).toBe(1);
    expect(patch).toEqual({ status: "unknown" });
  });

  test("auth = notion-cli → uses cli resolver via fetch(canonicalId)", async () => {
    const cliCfg: NotionIdentityConfig = { ...REST_CFG, auth: "notion-cli" };
    let cliCalls = 0;
    const adapter = makeAdapter({
      loadIdentityConfig: () => IDENTITY(cliCfg),
      createCliResolver: () => {
        cliCalls += 1;
        return fakeCliResolver({ state: "open" });
      },
    });
    const patch = await adapter.pull("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(cliCalls).toBe(1);
    expect(patch).toEqual({ status: "open" });
  });

  test("missing notion source throws NotionDomainAdapterError", async () => {
    const adapter = makeAdapter({
      loadIdentityConfig: () => ({
        sources: {
          github: {
            name: "github",
            kind: "github",
            canonicalIdPattern: /^GH-\d+$/,
            source: "<test>",
          },
        },
        defaultSourceName: "github",
        isDefault: true,
      }),
    });
    await expect(adapter.pull("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      NotionDomainAdapterError,
    );
  });
});

// ── push — REST only ──────────────────────────────────────────────────────

describe("NotionDomainAdapter.push", () => {
  test("linked path: PATCH /pages/<id> with title property; no bd write-back", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: "page-id" }));
    const bd = recordingBdExec();
    const adapter = makeAdapter({ fetchImpl, run: bd.run });
    const result = await adapter.push(
      bead({ externalRefs: { notion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
      { title: "Renamed" },
    );
    expect(result).toEqual({
      externalId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created: false,
      edited: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls[0]!.init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0]!.init?.body as string) as {
      properties: Record<string, unknown>;
    };
    expect(body.properties).toHaveProperty("Name");
    expect(bd.calls).toEqual([]);
  });

  test("linked path: no fields → no PATCH, returns linked id with edited=false", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new Error("fetch should not be called");
    });
    const adapter = makeAdapter({ fetchImpl });
    const result = await adapter.push(
      bead({ externalRefs: { notion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
      {},
    );
    expect(result.created).toBe(false);
    expect(calls).toEqual([]);
  });

  test("unlinked path: POST /pages then bd update --metadata external_refs.notion=<uuid>", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: "page-uuid-new" }));
    const bd = recordingBdExec();
    const adapter = makeAdapter({
      fetchImpl,
      run: bd.run,
      loadAllBeads: () => [],
    });
    const result = await adapter.push(bead(), { title: "Brand new", body: "hello" });
    expect(result).toEqual({ externalId: "page-uuid-new", created: true, edited: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init?.body as string) as {
      parent: { database_id: string };
      properties: Record<string, unknown>;
      children?: unknown[];
    };
    expect(body.parent).toEqual({ database_id: "db-abc" });
    expect(body.properties).toHaveProperty("Internal ID");
    expect(body.properties).toHaveProperty("Name");
    expect(Array.isArray(body.children)).toBe(true);
    expect(bd.calls).toEqual([
      {
        subcommand: "update",
        args: ["ai-home-x", "--metadata", "external_refs.notion=page-uuid-new"],
        state: "planning",
        role: "planner",
      },
    ]);
  });

  test("unlinked path: refuses to create on title-exact collision with an already-mirrored bd", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new Error("POST /pages should not be called");
    });
    const bd = recordingBdExec();
    const adapter = makeAdapter({
      fetchImpl,
      run: bd.run,
      loadAllBeads: () => [
        bead({
          id: "ai-home-other",
          title: "My issue",
          externalRefs: { notion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ],
    });
    await expect(adapter.push(bead(), { title: "My issue" })).rejects.toThrow(
      /refusing to create a duplicate Notion page/i,
    );
    expect(calls).toEqual([]);
    expect(bd.calls).toEqual([]);
  });

  test("refuses to push when auth is read-only (claude-mcp / notion-cli)", async () => {
    const cfg: NotionIdentityConfig = { ...REST_CFG, auth: "claude-mcp" };
    const adapter = makeAdapter({ loadIdentityConfig: () => IDENTITY(cfg) });
    await expect(adapter.push(bead(), { title: "x" })).rejects.toThrow(/read-only/i);
  });

  test("refuses to push when NOTION_TOKEN is unset", async () => {
    const adapter = makeAdapter({ env: {} });
    await expect(adapter.push(bead(), { title: "x" })).rejects.toThrow(/NOTION_TOKEN/);
  });

  test("propagates non-2xx errors as NotionDomainAdapterError with status", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: "rate limited" }, 429));
    const adapter = makeAdapter({ fetchImpl, loadAllBeads: () => [] });
    await expect(adapter.push(bead(), { title: "x" })).rejects.toBeInstanceOf(
      NotionDomainAdapterError,
    );
  });
});

// ── resolve / resolveFromBeads ────────────────────────────────────────────

describe("NotionDomainAdapter.resolve / resolveFromBeads", () => {
  const records: BeadsRecord[] = [
    bead({
      id: "ai-home-a",
      externalRefs: { notion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }),
    bead({
      id: "ai-home-b",
      externalRefs: { notion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    }),
  ];

  test("resolve via in-memory beads (page UUID → bd short-id)", async () => {
    const adapter = makeAdapter({ loadAllBeads: () => records });
    expect(await adapter.resolve("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ai-home-a");
    expect(await adapter.resolve("cccccccccccccccccccccccccccccccc")).toBeNull();
  });

  test("resolveFromBeads is the sync sibling — same dispatch contract", () => {
    const adapter = makeAdapter();
    expect(adapter.resolveFromBeads("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", records)).toBe("ai-home-b");
    expect(adapter.resolveFromBeads("not-a-uuid", records)).toBeNull();
    expect(adapter.resolveFromBeads("ai-home-a", records)).toBeNull();
  });
});

// ── bulkClose ─────────────────────────────────────────────────────────────

describe("NotionDomainAdapter.bulkClose", () => {
  test("loops bd update <id> --status closed for each provided bead id", () => {
    const bd = recordingBdExec();
    const adapter = makeAdapter({ run: bd.run });
    const result = adapter.bulkClose({
      cwd: "/repo",
      beadIds: ["ai-home-1", "ai-home-2", "ai-home-3"],
    });
    expect(result.exitCode).toBe(0);
    expect(bd.calls).toEqual([
      {
        subcommand: "update",
        args: ["ai-home-1", "--status", "closed"],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
      {
        subcommand: "update",
        args: ["ai-home-2", "--status", "closed"],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
      {
        subcommand: "update",
        args: ["ai-home-3", "--status", "closed"],
        cwd: "/repo",
        state: "planning",
        role: "planner",
      },
    ]);
  });

  test("first non-zero exit short-circuits and propagates", () => {
    let n = 0;
    const adapter = makeAdapter({
      run: ((_cmd: string[]) => {
        n += 1;
        if (n === 2) {
          return { status: 7, stdout: "", stderr: "boom" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }) as never,
    });
    const result = adapter.bulkClose({
      cwd: "/repo",
      beadIds: ["a", "b", "c"],
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("boom");
    expect(n).toBe(2); // never reached "c"
  });

  test("no beadIds → no-op exit 0", () => {
    const bd = recordingBdExec();
    const adapter = makeAdapter({ run: bd.run });
    expect(adapter.bulkClose({ cwd: "/repo", beadIds: [] })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(bd.calls).toEqual([]);
  });
});
