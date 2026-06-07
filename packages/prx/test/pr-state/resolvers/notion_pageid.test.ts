// NotionResolver — the GH-1420 page-id surface (findPageId / fetchByPageId)
// that scout uses. UUID inputs short-circuit the database query; Task-IDs reuse
// the canonical-id filter; fetchByPageId retrieves a page by UUID directly.
// Driven through the injected fetch seam — no real Notion API.

import { describe, expect, test } from "bun:test";

import { NotionResolver } from "../../../src/pr-state/resolvers/notion.ts";
import type { NotionIdentityConfig } from "../../../src/pr-state/github.ts";

const config: NotionIdentityConfig = {
  auth: "rest",
  databaseId: "abc123",
  idProperty: "ID",
  titleProperty: "Name",
  statusProperty: "Status",
  tokenOpRef: null,
};

const PAGE_UUID = "11111111-1111-1111-1111-111111111111";

type FetchCall = { url: string; method?: string | undefined };

function makeFetch(handlers: Array<() => Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected fetch call: ${calls.at(-1)?.url}`);
    return handler();
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const env = { NOTION_TOKEN: "secret_xyz" };

describe("findPageId", () => {
  test("a Notion UUID short-circuits the database query", async () => {
    const { fetch, calls } = makeFetch([]); // no fetch expected
    const resolver = new NotionResolver(config, env, fetch);
    const lookup = await resolver.findPageId(PAGE_UUID);
    expect(lookup).toEqual({ pageId: PAGE_UUID, pageUrl: null });
    expect(calls).toHaveLength(0);
  });

  test("throws when database_id / id_property are missing for a Task-ID", async () => {
    const { fetch } = makeFetch([]);
    const resolver = new NotionResolver({ ...config, databaseId: null }, env, fetch);
    await expect(resolver.findPageId("PROJECT-42")).rejects.toThrow(/requires database_id and id_property/);
  });

  test("a Task-ID resolves through the canonical-id filter query", async () => {
    const { fetch, calls } = makeFetch([
      () => json(200, { results: [{ id: "page-9", url: "https://notion.so/page-9" }] }),
    ]);
    const resolver = new NotionResolver(config, env, fetch);
    const lookup = await resolver.findPageId("PROJECT-42");
    expect(lookup).toEqual({ pageId: "page-9", pageUrl: "https://notion.so/page-9" });
    expect(calls[0]!.url).toContain("/databases/abc123/query");
    expect(calls[0]!.method).toBe("POST");
  });

  test("a Task-ID with no url comes back with pageUrl null", async () => {
    const { fetch } = makeFetch([() => json(200, { results: [{ id: "page-10" }] })]);
    const resolver = new NotionResolver(config, env, fetch);
    expect(await resolver.findPageId("PROJECT-43")).toEqual({ pageId: "page-10", pageUrl: null });
  });
});

describe("fetchByPageId", () => {
  test("throws when title_property is missing", async () => {
    const { fetch } = makeFetch([]);
    const resolver = new NotionResolver({ ...config, titleProperty: null }, env, fetch);
    await expect(resolver.fetchByPageId(PAGE_UUID)).rejects.toThrow(/requires title_property/);
  });

  test("retrieves a page by UUID and renders it to a ResolvedWorkUnit", async () => {
    const { fetch, calls } = makeFetch([
      () =>
        json(200, {
          id: PAGE_UUID,
          url: "https://notion.so/the-page",
          properties: {
            Name: { title: [{ plain_text: "Direct fetch" }] },
            Status: { status: { name: "Done" } },
          },
        }),
      () => json(200, { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body text." }] } }] }),
    ]);
    const resolver = new NotionResolver(config, env, fetch);
    const resolved = await resolver.fetchByPageId(PAGE_UUID);
    expect(resolved).toMatchObject({
      id: PAGE_UUID,
      title: "Direct fetch",
      body: "Body text.",
      state: "closed",
      url: "https://notion.so/the-page",
      source: "notion",
    });
    expect(calls[0]!.url).toContain(`/pages/${PAGE_UUID}`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.url).toContain(`/blocks/${PAGE_UUID}/children`);
  });

  test("a non-ok page retrieve surfaces the Notion error", async () => {
    const { fetch } = makeFetch([() => json(404, { message: "Not found" })]);
    const resolver = new NotionResolver(config, env, fetch);
    await expect(resolver.fetchByPageId(PAGE_UUID)).rejects.toThrow(/page retrieve failed \(404\): Not found/);
  });

  test("falls back to the requested pageId when the retrieve omits id/url", async () => {
    const { fetch } = makeFetch([
      () => json(200, { properties: { Name: { title: [{ plain_text: "No id echoed" }] } } }),
      () => json(200, { results: [] }),
    ]);
    const resolver = new NotionResolver(config, env, fetch);
    const resolved = await resolver.fetchByPageId(PAGE_UUID);
    expect(resolved.id).toBe(PAGE_UUID);
    expect(resolved.url).toBeNull();
    expect(resolved.state).toBe("unknown"); // no Status property → unknown
    expect(resolved.body).toBeNull(); // empty block-children → null body
  });
});
