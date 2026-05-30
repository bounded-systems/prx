import { describe, expect, test } from "bun:test";

import { resolverForCanonicalId } from "../../../src/pr-state/resolvers/dispatch.ts";
import { BeadsResolver } from "../../../src/pr-state/resolvers/beads.ts";
import { GithubResolver } from "../../../src/pr-state/resolvers/github.ts";
import { NotionResolver } from "../../../src/pr-state/resolvers/notion.ts";
import { NotionClaudeMcpResolver } from "../../../src/pr-state/resolvers/notion_claude_mcp.ts";
import { NotionCliResolver } from "../../../src/pr-state/resolvers/notion_cli.ts";
import type {
  IdentityConfig,
  NotionAuthMode,
  SourceConfig,
} from "../../../src/pr-state/github.ts";

function notionSource(name: string, pattern: RegExp, auth: NotionAuthMode): SourceConfig {
  return {
    name,
    kind: "notion",
    canonicalIdPattern: pattern,
    source: "<test>",
    notion: {
      auth,
      databaseId: auth === "rest" ? "db-1" : null,
      idProperty: auth === "rest" ? "ID" : null,
      titleProperty: auth === "rest" ? "Name" : null,
      statusProperty: null,
      tokenOpRef: null,
    },
  };
}

function githubSource(): SourceConfig {
  return {
    name: "github",
    kind: "github",
    canonicalIdPattern: /^GH-\d+$/,
    source: "<test>",
  };
}

const defaultConfig: IdentityConfig = {
  sources: { github: githubSource() },
  defaultSourceName: "github",
  isDefault: true,
};

const notionConfig: IdentityConfig = {
  sources: {
    github: githubSource(),
    notion: notionSource("notion", /^PROJECT-\d+$/, "rest"),
  },
  defaultSourceName: "notion",
  isDefault: false,
};

const claudeMcpConfig: IdentityConfig = {
  sources: {
    notion: notionSource("notion", /^PROJECT-\d+$/, "claude-mcp"),
  },
  defaultSourceName: "notion",
  isDefault: false,
};

const notionCliConfig: IdentityConfig = {
  sources: {
    notion: notionSource("notion", /^PROJ-\d+$/, "notion-cli"),
  },
  defaultSourceName: "notion",
  isDefault: false,
};

describe("resolverForCanonicalId", () => {
  test("returns a GithubResolver for a GH-<n> id", () => {
    const resolver = resolverForCanonicalId("GH-42", defaultConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(GithubResolver);
  });

  test("returns a NotionResolver for a non-GH id when a notion source is registered", () => {
    const resolver = resolverForCanonicalId("PROJECT-6688", notionConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(NotionResolver);
  });

  test("returns null for a non-GH id when no source matches", () => {
    const resolver = resolverForCanonicalId("PROJECT-6688", defaultConfig, "/tmp/repo");
    expect(resolver).toBeNull();
  });

  test("prefers the GithubResolver for GH-<n> even when a notion source is registered", () => {
    const resolver = resolverForCanonicalId("GH-1", notionConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(GithubResolver);
  });

  test("returns a NotionClaudeMcpResolver when auth = \"claude-mcp\"", () => {
    const resolver = resolverForCanonicalId("PROJECT-6688", claudeMcpConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(NotionClaudeMcpResolver);
  });

  test("returns a NotionResolver (not claude-mcp) when auth = \"rest\"", () => {
    const resolver = resolverForCanonicalId("PROJECT-6688", notionConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(NotionResolver);
  });

  test("returns a NotionCliResolver when auth = \"notion-cli\"", () => {
    const resolver = resolverForCanonicalId("PROJ-5743", notionCliConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(NotionCliResolver);
  });

  // GH-1766: bd surface arm. Routed before the Notion arm so a bd id
  // never falls through to a Notion resolver configured on the same repo.
  test("returns a BeadsResolver for a BD-<8hex> short surface id", () => {
    const resolver = resolverForCanonicalId("BD-a1b2c3d4", defaultConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(BeadsResolver);
  });

  test("BD- surface routing wins over a Notion source on the same repo", () => {
    const resolver = resolverForCanonicalId("BD-a1b2c3d4", notionConfig, "/tmp/repo");
    expect(resolver).toBeInstanceOf(BeadsResolver);
  });

  // GH-1421: --source=<name> explicit dispatch
  test("explicit --source=<name> routes to that registry entry", () => {
    const resolver = resolverForCanonicalId(
      "PROJECT-6688",
      notionConfig,
      "/tmp/repo",
      { source: "notion" },
    );
    expect(resolver).toBeInstanceOf(NotionResolver);
  });

  test("explicit --source=<name> with a pattern mismatch returns null", () => {
    const resolver = resolverForCanonicalId(
      "GH-1",
      notionConfig,
      "/tmp/repo",
      { source: "notion" },
    );
    expect(resolver).toBeNull();
  });

  test("explicit --source=<unknown> returns null", () => {
    const resolver = resolverForCanonicalId(
      "PROJECT-6688",
      notionConfig,
      "/tmp/repo",
      { source: "foo" },
    );
    expect(resolver).toBeNull();
  });

  test("multi-source registry: first matching pattern wins (no explicit --source)", () => {
    const config: IdentityConfig = {
      sources: {
        a: notionSource("a", /^A-\d+$/, "rest"),
        b: notionSource("b", /^B-\d+$/, "rest"),
      },
      defaultSourceName: "a",
      isDefault: false,
    };
    expect(resolverForCanonicalId("A-1", config, "/tmp/repo")).toBeInstanceOf(NotionResolver);
    expect(resolverForCanonicalId("B-1", config, "/tmp/repo")).toBeInstanceOf(NotionResolver);
    expect(resolverForCanonicalId("C-1", config, "/tmp/repo")).toBeNull();
  });
});
