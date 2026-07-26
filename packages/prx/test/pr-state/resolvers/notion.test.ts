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

type FetchCall = { url: string; body?: string | undefined; method?: string | undefined };

function makeFetch(handlers: Array<(call: FetchCall) => Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
    };
    calls.push(call);
    const handler = handlers[index++];
    if (!handler) {
      throw new Error(`unexpected fetch call: ${call.url}`);
    }
    return handler(call);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NotionResolver", () => {
  test("fetch returns a ResolvedWorkUnit when the page is found", async () => {
    const { fetch, calls } = makeFetch([
      (_call) =>
        jsonResponse(200, {
          results: [
            {
              id: "page-1",
              url: "https://notion.so/page-1",
              properties: {
                Name: { title: [{ plain_text: "Build feature X" }] },
                Status: { status: { name: "In progress" } },
              },
            },
          ],
        }),
      (_call) =>
        jsonResponse(200, {
          results: [
            { type: "paragraph", paragraph: { rich_text: [{ plain_text: "First paragraph." }] } },
            { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Section" }] } },
            { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Second paragraph." }] } },
          ],
        }),
    ]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "secret_xyz" }, fetch);
    const resolved = await resolver.fetch("PROJECT-6688");
    expect(resolved.source).toBe("notion");
    expect(resolved.title).toBe("Build feature X");
    expect(resolved.state).toBe("open");
    expect(resolved.body).toBe("First paragraph.\n\nSection\n\nSecond paragraph.");
    expect(resolved.url).toBe("https://notion.so/page-1");
    expect(calls[0]!.url).toContain("/databases/abc123/query");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain('"ID"');
    expect(calls[0]!.body).toContain("PROJECT-6688");
    expect(calls[1]!.url).toContain("/blocks/page-1/children");
  });

  test("fetch paginates the block-children request until has_more is false", async () => {
    const { fetch, calls } = makeFetch([
      (_call) =>
        jsonResponse(200, {
          results: [
            {
              id: "p",
              properties: {
                Name: { title: [{ plain_text: "t" }] },
                Status: { status: { name: "In progress" } },
              },
            },
          ],
        }),
      (_call) =>
        jsonResponse(200, {
          results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "page 1" }] } }],
          has_more: true,
          next_cursor: "cursor-abc",
        }),
      (_call) =>
        jsonResponse(200, {
          results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "page 2" }] } }],
          has_more: false,
          next_cursor: null,
        }),
    ]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "t" }, fetch);
    const resolved = await resolver.fetch("PROJECT-1");
    expect(resolved.body).toBe("page 1\n\npage 2");
    expect(calls[2]!.url).toContain("start_cursor=cursor-abc");
  });

  test("fetch maps 'Done' status to closed", async () => {
    const { fetch } = makeFetch([
      (_call) =>
        jsonResponse(200, {
          results: [
            {
              id: "page-x",
              url: null,
              properties: {
                Name: { title: [{ plain_text: "Done thing" }] },
                Status: { status: { name: "Done" } },
              },
            },
          ],
        }),
      (_call) => jsonResponse(200, { results: [] }),
    ]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "t" }, fetch);
    const resolved = await resolver.fetch("PROJECT-1");
    expect(resolved.state).toBe("closed");
  });

  test("fetch throws when the database returns no matching page", async () => {
    const { fetch } = makeFetch([(_call) => jsonResponse(200, { results: [] })]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "t" }, fetch);
    await expect(resolver.fetch("PROJECT-404")).rejects.toThrow(/no page matching/);
  });

  test("fetch throws when multiple pages match", async () => {
    const { fetch } = makeFetch([
      (_call) =>
        jsonResponse(200, {
          results: [
            { id: "a", properties: { Name: { title: [] }, Status: { status: { name: "x" } } } },
            { id: "b", properties: { Name: { title: [] }, Status: { status: { name: "x" } } } },
          ],
        }),
    ]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "t" }, fetch);
    await expect(resolver.fetch("PROJECT-DUP")).rejects.toThrow(/ambiguous/);
  });

  test("fetch surfaces the Notion error message on non-200", async () => {
    const { fetch } = makeFetch([
      (_call) => jsonResponse(401, { message: "API token is invalid." }),
    ]);
    const resolver = new NotionResolver(config, { NOTION_TOKEN: "t" }, fetch);
    await expect(resolver.fetch("PROJECT-1")).rejects.toThrow(/401.*API token is invalid/);
  });

  test("fetch throws when NOTION_TOKEN is missing", async () => {
    const { fetch } = makeFetch([]);
    const resolver = new NotionResolver(config, {}, fetch);
    await expect(resolver.fetch("PROJECT-1")).rejects.toThrow(/NOTION_TOKEN environment variable/);
  });

  test("fetch sends Notion-Version and Authorization headers", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return jsonResponse(200, {
        results: [{ id: "p", properties: { Name: { title: [{ plain_text: "t" }] } } }],
      });
    };
    const resolver = new NotionResolver(
      { ...config, statusProperty: null },
      { NOTION_TOKEN: "secret_123" },
      fetchImpl as typeof fetch,
    );
    // subsequent blocks call gets a new fetch — we return ok body here
    const _ = resolver.fetch("PROJECT-1").catch(() => {});
    await _;
    expect(capturedHeaders).toMatchObject({
      Authorization: "Bearer secret_123",
      "Notion-Version": expect.any(String),
    });
  });
});
