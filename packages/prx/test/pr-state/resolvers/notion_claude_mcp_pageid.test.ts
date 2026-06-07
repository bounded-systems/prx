// pr-state/resolvers/notion_claude_mcp — the GH-1420 page-id short-circuit
// (a Notion UUID resolves without any claude/MCP round-trip).

import { describe, expect, test } from "bun:test";

import { NotionClaudeMcpResolver } from "../../../src/pr-state/resolvers/notion_claude_mcp.ts";
import type { NotionIdentityConfig } from "../../../src/pr-state/github.ts";

const config: NotionIdentityConfig = {
  auth: "claude-mcp",
  databaseId: "db",
  idProperty: "ID",
  titleProperty: "Name",
  statusProperty: "Status",
  tokenOpRef: null,
} as NotionIdentityConfig;

describe("NotionClaudeMcpResolver.findPageId", () => {
  test("a Notion UUID short-circuits the search (no runner call)", async () => {
    let called = false;
    const runner = (() => {
      called = true;
      return { stdout: "", stderr: "", status: 0 };
    }) as never;
    const resolver = new NotionClaudeMcpResolver(config, "/repo", runner, { HOME: "/tmp" });
    const lookup = await resolver.findPageId("11111111-1111-1111-1111-111111111111");
    expect(lookup).toEqual({ pageId: "11111111-1111-1111-1111-111111111111", pageUrl: null });
    expect(called).toBe(false);
  });
});
