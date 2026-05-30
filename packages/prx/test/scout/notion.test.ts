// GH-1420 — `scout notion <id>` resolver. Tests inject a stub
// `WorkUnitResolver`, `execGh`, and `execBd` so coverage is hermetic and
// stable across worktrees (no real Notion / GH / bd traffic).

import { describe, expect, test } from "bun:test";

import {
  detectNotionId,
  formatScoutNotionJson,
  runScoutNotion,
  ScoutNotionError,
  scoutNotionResultSchema,
  type NotionResolverFactory,
} from "../../src/scout/notion.ts";
import type { IdentityConfig, NotionIdentityConfig } from "../../src/pr-state/github.ts";
import type {
  NotionPageLookup,
  NotionPageResolver,
  ResolvedWorkUnit,
} from "../../src/pr-state/resolvers/types.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BdExecResult } from "@bounded-systems/bd";

const UUID = "1f2e3d4c-5678-90ab-cdef-1234567890ab";

function buildIdentity(notion: NotionIdentityConfig | null): IdentityConfig {
  const pattern = /^[A-Z][A-Z0-9]+-\d+$/;
  if (notion === null) {
    return {
      sources: {
        github: {
          name: "github",
          kind: "github",
          canonicalIdPattern: pattern,
          source: "<test>",
        },
      },
      defaultSourceName: "github",
      isDefault: false,
    };
  }
  return {
    sources: {
      notion: {
        name: "notion",
        kind: "notion",
        canonicalIdPattern: pattern,
        source: "<test>",
        notion,
      },
    },
    defaultSourceName: "notion",
    isDefault: false,
  };
}

function stubResolver(opts: {
  findPageId?: (id: string) => Promise<NotionPageLookup>;
  fetchByPageId?: (pageId: string) => Promise<ResolvedWorkUnit>;
}): NotionPageResolver {
  return {
    name: "notion",
    fetch: async () => {
      throw new Error("stubResolver.fetch should not be called by runScoutNotion");
    },
    findPageId:
      opts.findPageId ??
      (async (id) => ({ pageId: id, pageUrl: null })),
    fetchByPageId:
      opts.fetchByPageId ??
      (async (pageId) => ({
        id: pageId,
        title: "Stub page",
        body: "Stub body",
        state: "open",
        url: `https://www.notion.so/${pageId}`,
        source: "notion",
      })),
  };
}

function stubGh(hits: Array<{ number: number; title?: string }>): typeof import("@bounded-systems/gh").execGh {
  const json = JSON.stringify(
    hits.map((h) => ({
      number: h.number,
      title: h.title ?? `mirror of UUID`,
      state: "OPEN",
      url: `https://github.com/x/y/issues/${h.number}`,
      labels: [],
    })),
  );
  return ((): GhExecResult => ({
    exitCode: 0,
    stdout: json,
    stderr: "",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/gh").execGh;
}

function ghError(): typeof import("@bounded-systems/gh").execGh {
  return ((): GhExecResult => ({
    exitCode: 1,
    stdout: "",
    stderr: "boom",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/gh").execGh;
}

function stubBd(records: Array<{ id: string; externalRef: string | null }>): typeof import("@bounded-systems/bd").execBd {
  const json = JSON.stringify(
    records.map((r) => ({
      id: r.id,
      title: "stub",
      description: "",
      status: "open",
      priority: 2,
      issue_type: "task",
      external_ref: r.externalRef,
      metadata: {},
    })),
  );
  return ((): BdExecResult => ({
    exitCode: 0,
    stdout: json,
    stderr: "",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

function bdError(): typeof import("@bounded-systems/bd").execBd {
  return ((): BdExecResult => ({
    exitCode: 1,
    stdout: "",
    stderr: "bd boom",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

const factoryFor =
  (resolver: NotionPageResolver): NotionResolverFactory =>
  () =>
    resolver;

describe("detectNotionId", () => {
  test("hyphenated UUID → kind=uuid (normalized lowercase)", () => {
    expect(detectNotionId(UUID.toUpperCase())).toEqual({
      kind: "uuid",
      value: UUID,
    });
  });

  test("unhyphenated 32-hex → kind=uuid (normalized)", () => {
    const flat = UUID.replace(/-/g, "");
    expect(detectNotionId(flat)).toEqual({ kind: "uuid", value: UUID });
  });

  test("Task-ID matching configured pattern → kind=task_id", () => {
    expect(detectNotionId("PROJ-5779", /^[A-Z][A-Z0-9]+-\d+$/)).toEqual({
      kind: "task_id",
      value: "PROJ-5779",
    });
  });

  test("empty string → MISSING_ID", () => {
    expect(() => detectNotionId("")).toThrow(ScoutNotionError);
    try {
      detectNotionId("");
    } catch (err) {
      expect((err as ScoutNotionError).code).toBe("MISSING_ID");
    }
  });

  test("garbage → INVALID_ID", () => {
    try {
      detectNotionId("not-an-id");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("INVALID_ID");
    }
  });

  test("Task-ID outside configured pattern → INVALID_ID", () => {
    try {
      // configured pattern requires at least 1 letter+digit prefix
      detectNotionId("Lower-1", /^[A-Z][A-Z0-9]+-\d+$/);
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("INVALID_ID");
    }
  });
});

describe("runScoutNotion", () => {
  test("UUID input + mirrors found resolves to single envelope", async () => {
    const resolver = stubResolver({
      findPageId: async (id) => ({ pageId: id, pageUrl: null }),
      fetchByPageId: async (pageId) => ({
        id: pageId,
        title: "Notion title",
        body: "Notion body",
        state: "open",
        url: `https://www.notion.so/${pageId}`,
        source: "notion",
      }),
    });
    const result = await runScoutNotion({
      id: UUID,
      loadIdentity: () =>
        buildIdentity({
          auth: "rest",
          databaseId: "db",
          idProperty: "Task ID",
          titleProperty: "Name",
          statusProperty: "Status",
          tokenOpRef: null,
        }),
      resolverFactory: factoryFor(resolver),
      ghExec: stubGh([{ number: 1234, title: "ref " + UUID }]),
      bdExec: stubBd([
        { id: "ai-home-abc", externalRef: "https://github.com/x/y/issues/1234" },
      ]),
    });
    expect(result.uuid).toBe(UUID);
    expect(result.task_id).toBeNull();
    expect(result.title).toBe("Notion title");
    expect(result.body).toBe("Notion body");
    expect(result.url).toBe(`https://www.notion.so/${UUID}`);
    expect(result.state).toBe("open");
    expect(result.gh_issue).toBe(1234);
    expect(result.bd_id).toBe("ai-home-abc");
    expect(result.intake_shape).toEqual({
      type: null,
      title: "Notion title",
      body: "Notion body",
    });
    // Schema parses cleanly.
    expect(scoutNotionResultSchema.safeParse(result).success).toBe(true);
  });

  test("Task-ID input populates task_id and resolves to canonical UUID", async () => {
    const resolver = stubResolver({
      findPageId: async () => ({
        pageId: UUID,
        pageUrl: `https://www.notion.so/${UUID}`,
      }),
      fetchByPageId: async (pageId) => ({
        id: pageId,
        title: "Task page",
        body: null,
        state: "closed",
        url: null,
        source: "notion",
      }),
    });
    const result = await runScoutNotion({
      id: "PROJ-5779",
      loadIdentity: () =>
        buildIdentity({
          auth: "claude-mcp",
          databaseId: null,
          idProperty: null,
          titleProperty: null,
          statusProperty: null,
          tokenOpRef: null,
        }),
      resolverFactory: factoryFor(resolver),
    });
    expect(result.uuid).toBe(UUID);
    expect(result.task_id).toBe("PROJ-5779");
    expect(result.state).toBe("closed");
    // Falls back to lookup pageUrl when fetch returns null url.
    expect(result.url).toBe(`https://www.notion.so/${UUID}`);
    expect(result.gh_issue).toBeNull();
    expect(result.bd_id).toBeNull();
  });

  test("--no-mirrors short-circuits gh+bd lookup", async () => {
    let ghCalls = 0;
    let bdCalls = 0;
    const ghExec = ((..._args: unknown[]): GhExecResult => {
      ghCalls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "", policy: null };
    }) as unknown as typeof import("@bounded-systems/gh").execGh;
    const bdExec = ((..._args: unknown[]): BdExecResult => {
      bdCalls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "", policy: null };
    }) as unknown as typeof import("@bounded-systems/bd").execBd;
    const result = await runScoutNotion({
      id: UUID,
      noMirrors: true,
      loadIdentity: () =>
        buildIdentity({
          auth: "rest",
          databaseId: "db",
          idProperty: "Task ID",
          titleProperty: "Name",
          statusProperty: "Status",
          tokenOpRef: null,
        }),
      resolverFactory: factoryFor(stubResolver({})),
      ghExec,
      bdExec,
    });
    expect(ghCalls).toBe(0);
    expect(bdCalls).toBe(0);
    expect(result.gh_issue).toBeNull();
    expect(result.bd_id).toBeNull();
  });

  test("mirrors absent → gh_issue=null, bd_id=null (no error)", async () => {
    const result = await runScoutNotion({
      id: UUID,
      loadIdentity: () =>
        buildIdentity({
          auth: "rest",
          databaseId: "db",
          idProperty: "Task ID",
          titleProperty: "Name",
          statusProperty: null,
          tokenOpRef: null,
        }),
      resolverFactory: factoryFor(stubResolver({})),
      ghExec: stubGh([]),
      bdExec: stubBd([]),
    });
    expect(result.gh_issue).toBeNull();
    expect(result.bd_id).toBeNull();
  });

  test("notion not configured → NOTION_NOT_CONFIGURED", async () => {
    try {
      await runScoutNotion({
        id: UUID,
        loadIdentity: () => buildIdentity(null),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("NOTION_NOT_CONFIGURED");
    }
  });

  test("auth=notion-cli is unsupported → NOTION_NOT_CONFIGURED", async () => {
    try {
      await runScoutNotion({
        id: UUID,
        loadIdentity: () =>
          buildIdentity({
            auth: "notion-cli",
            databaseId: null,
            idProperty: null,
            titleProperty: null,
            statusProperty: null,
            tokenOpRef: null,
          }),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("NOTION_NOT_CONFIGURED");
    }
  });

  test("invalid id → INVALID_ID (no resolver call)", async () => {
    let resolverCalls = 0;
    const resolver = stubResolver({
      findPageId: async (id) => {
        resolverCalls += 1;
        return { pageId: id, pageUrl: null };
      },
    });
    try {
      await runScoutNotion({
        id: "garbage",
        loadIdentity: () =>
          buildIdentity({
            auth: "rest",
            databaseId: "db",
            idProperty: "Task ID",
            titleProperty: "Name",
            statusProperty: null,
            tokenOpRef: null,
          }),
        resolverFactory: factoryFor(resolver),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("INVALID_ID");
    }
    expect(resolverCalls).toBe(0);
  });

  test("resolver findPageId throws → NOTION_LOOKUP_FAILED", async () => {
    const resolver = stubResolver({
      findPageId: async () => {
        throw new Error("notion-search exploded");
      },
    });
    try {
      await runScoutNotion({
        id: "PROJ-1",
        loadIdentity: () =>
          buildIdentity({
            auth: "claude-mcp",
            databaseId: null,
            idProperty: null,
            titleProperty: null,
            statusProperty: null,
            tokenOpRef: null,
          }),
        resolverFactory: factoryFor(resolver),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("NOTION_LOOKUP_FAILED");
    }
  });

  test("resolver fetchByPageId throws → NOTION_FETCH_FAILED", async () => {
    const resolver = stubResolver({
      fetchByPageId: async () => {
        throw new Error("page retrieve 404");
      },
    });
    try {
      await runScoutNotion({
        id: UUID,
        loadIdentity: () =>
          buildIdentity({
            auth: "rest",
            databaseId: "db",
            idProperty: "Task ID",
            titleProperty: "Name",
            statusProperty: null,
            tokenOpRef: null,
          }),
        resolverFactory: factoryFor(resolver),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("NOTION_FETCH_FAILED");
    }
  });

  test("gh tool error → MIRROR_LOOKUP_FAILED", async () => {
    try {
      await runScoutNotion({
        id: UUID,
        loadIdentity: () =>
          buildIdentity({
            auth: "rest",
            databaseId: "db",
            idProperty: "Task ID",
            titleProperty: "Name",
            statusProperty: null,
            tokenOpRef: null,
          }),
        resolverFactory: factoryFor(stubResolver({})),
        ghExec: ghError(),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("MIRROR_LOOKUP_FAILED");
    }
  });

  test("bd tool error after a gh hit → MIRROR_LOOKUP_FAILED", async () => {
    try {
      await runScoutNotion({
        id: UUID,
        loadIdentity: () =>
          buildIdentity({
            auth: "rest",
            databaseId: "db",
            idProperty: "Task ID",
            titleProperty: "Name",
            statusProperty: null,
            tokenOpRef: null,
          }),
        resolverFactory: factoryFor(stubResolver({})),
        ghExec: stubGh([{ number: 9, title: UUID }]),
        bdExec: bdError(),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScoutNotionError);
      expect((err as ScoutNotionError).code).toBe("MIRROR_LOOKUP_FAILED");
    }
  });

  test("formatScoutNotionJson emits a single line of strict JSON", async () => {
    const result = await runScoutNotion({
      id: UUID,
      loadIdentity: () =>
        buildIdentity({
          auth: "rest",
          databaseId: "db",
          idProperty: "Task ID",
          titleProperty: "Name",
          statusProperty: null,
          tokenOpRef: null,
        }),
      resolverFactory: factoryFor(stubResolver({})),
    });
    const text = formatScoutNotionJson(result);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual(result);
  });
});
