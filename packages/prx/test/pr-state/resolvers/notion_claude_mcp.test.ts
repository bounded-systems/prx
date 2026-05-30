import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { NotionClaudeMcpResolver } from "../../../src/pr-state/resolvers/notion_claude_mcp.ts";
import type { CommandRunner, NotionIdentityConfig } from "../../../src/pr-state/github.ts";

const config: NotionIdentityConfig = {
  auth: "claude-mcp",
  databaseId: null,
  idProperty: null,
  titleProperty: null,
  statusProperty: null,
  tokenOpRef: null,
};

// GH-867: isolate every test's cache from the operator's real ~/.cache.
function makeEnv(xdgCacheHome: string): NodeJS.ProcessEnv {
  return { XDG_CACHE_HOME: xdgCacheHome, HOME: xdgCacheHome };
}

// GH-867: the resolver's `git remote get-url origin` probe returns non-zero
// in tests (no real remote), so the cache resolves to `_anon/<fingerprint>`.
function anonNotionDir(xdgCacheHome: string, repoRoot: string): string {
  const fingerprint = createHash("sha256")
    .update(resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return join(xdgCacheHome, "prx", "notion", "_anon", fingerprint);
}

function taskCacheFile(xdgCacheHome: string, repoRoot: string, id: string): string {
  return join(anonNotionDir(xdgCacheHome, repoRoot), `${id}.json`);
}

function envelope(resultJson: string) {
  return JSON.stringify([
    { type: "system", subtype: "init", session_id: "t", cwd: "/t" },
    { type: "result", subtype: "success", is_error: false, result: resultJson },
  ]);
}

function legacyEnvelope(resultJson: string) {
  return JSON.stringify({ type: "result", result: resultJson });
}

function makeRunner(
  handlers: Array<(cmd: string[]) => { stdout: string; stderr?: string; status?: number }>,
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const runner: CommandRunner = (cmd) => {
    // GH-867: stub the `git remote get-url origin` probe to "no remote" so the
    // resolver falls through to the anon-fallback cache dir.
    if (cmd[0] === "git" && cmd.includes("remote")) {
      return { stdout: "", stderr: "no remote", status: 1 };
    }
    calls.push(cmd);
    const handler = handlers[index++];
    if (!handler) {
      throw new Error(`unexpected claude call: ${cmd.join(" ")}`);
    }
    const result = handler(cmd);
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
    };
  };
  return { runner, calls };
}

describe("NotionClaudeMcpResolver", () => {
  test("happy path: runs lookup then fetch and caches both into a single unified file", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-"));
    const { runner, calls } = makeRunner([
      () => ({
        stdout: envelope('{"pageId": "page-42", "pageUrl": "https://notion.so/page-42"}'),
      }),
      () => ({
        stdout: envelope(
          '{"title": "Build feature X", "body": "p1\\n\\np2", "state": "open", "url": "https://notion.so/page-42"}',
        ),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROD-1");
    expect(resolved.source).toBe("notion");
    expect(resolved.title).toBe("Build feature X");
    expect(resolved.body).toBe("p1\n\np2");
    expect(resolved.state).toBe("open");
    expect(resolved.url).toBe("https://notion.so/page-42");
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe("claude");

    // GH-867: one unified file with both `lookup` and `fetch` halves.
    const cachePath = taskCacheFile(xdg, repoRoot, "PROD-1");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached.schemaVersion).toBe(1);
    expect(cached.lookup).toEqual({
      pageId: "page-42",
      title: null,
      url: "https://notion.so/page-42",
    });
    expect(cached.fetch.title).toBe("Build feature X");
    expect(cached.fetch.body).toBe("p1\n\np2");
    expect(cached.fetch.state).toBe("open");
    expect(cached.fetch.url).toBe("https://notion.so/page-42");
    expect(typeof cached.fetch.fetchedAt).toBe("string");
    // GH-867: no writes under the worktree's .prx anymore.
    expect(existsSync(join(repoRoot, ".prx/notion-cache"))).toBe(false);
  });

  test("cache hit: unified file present → zero subprocess calls", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-hit-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-hit-"));
    const cacheDir = anonNotionDir(xdg, repoRoot);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "PROD-2.json"),
      JSON.stringify({
        schemaVersion: 1,
        lookup: { pageId: "p2", title: null, url: "https://x" },
        fetch: {
          title: "Cached",
          body: "cached body",
          state: "open",
          url: "https://x",
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const { runner, calls } = makeRunner([]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROD-2");
    expect(resolved.title).toBe("Cached");
    expect(calls.length).toBe(0);
  });

  test("invalidateFetch: clears fetch half only, lookup preserved", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-invalidate-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-invalidate-"));
    const cacheDir = anonNotionDir(xdg, repoRoot);
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "PROD-3.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        lookup: { pageId: "p3", title: null, url: null },
        fetch: {
          title: "Stale",
          body: null,
          state: "open",
          url: null,
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const { runner, calls } = makeRunner([
      () => ({
        stdout: envelope('{"title": "Fresh", "body": null, "state": "open", "url": null}'),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    resolver.invalidateFetch("PROD-3");
    // GH-867: lookup half is preserved, fetch half is cleared.
    const after = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(after.lookup).toEqual({ pageId: "p3", title: null, url: null });
    expect(after.fetch).toBeUndefined();

    const resolved = await resolver.fetch("PROD-3");
    expect(resolved.title).toBe("Fresh");
    expect(calls.length).toBe(1);
  });

  test("throws when claude binary missing on PATH (ENOENT)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-enoent-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-enoent-"));
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "git") {
        return { stdout: "", stderr: "", status: 1 };
      }
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-4")).rejects.toThrow(/`claude` binary not found/);
  });

  test("throws on malformed JSON in claude output", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-bad-json-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-bad-json-"));
    const { runner } = makeRunner([
      () => ({ stdout: envelope("this is not json at all") }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-5")).rejects.toThrow(
      /did not contain JSON|could not parse JSON/,
    );
  });

  test("throws on claude error envelope", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-err-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-err-"));
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { type: "system", subtype: "init" },
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            error: "auth failed",
          },
        ]),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-6")).rejects.toThrow(/error envelope/);
  });

  test("accepts legacy single-object envelope from older claude CLI", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-legacy-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-legacy-"));
    const { runner } = makeRunner([
      () => ({ stdout: legacyEnvelope('{"pageId": "p-legacy", "pageUrl": null}') }),
      () => ({
        stdout: legacyEnvelope(
          '{"title": "Legacy", "body": null, "state": "open", "url": null}',
        ),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROD-LEGACY");
    expect(resolved.title).toBe("Legacy");
  });

  test("array without terminal result event → clear error naming event types", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-no-terminal-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-no-terminal-"));
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
        ]),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-NO-RESULT")).rejects.toThrow(
      /no terminal "result" event.*types: system,assistant/,
    );
  });

  test("search missing pageId field → clear error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-missing-pageid-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-missing-pageid-"));
    const { runner } = makeRunner([
      () => ({ stdout: envelope('{"pageUrl": "https://x"}') }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-7")).rejects.toThrow(/missing "pageId"/);
  });

  test("search not_found → clear error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-404-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-404-"));
    const { runner } = makeRunner([
      () => ({ stdout: envelope('{"error": "not_found"}') }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-404")).rejects.toThrow(/no page matching/);
  });

  test("claude non-zero exit → error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-nonzero-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-nonzero-"));
    const { runner } = makeRunner([
      () => ({ stdout: "", stderr: "boom", status: 2 }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-9")).rejects.toThrow(/claude exited with status 2/);
  });

  test("headless OAuth signature in stdout with status 0 → GH-847 error before envelope parse", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-oauth-stdout-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-oauth-stdout-"));
    const oauthStdout =
      "Please open this URL in your browser to authorize Notion access:\n" +
      "https://mcp.notion.com/authorize?response_type=code&client_id=foo";
    const { runner, calls } = makeRunner([
      () => ({ stdout: oauthStdout, status: 0 }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-OAUTH-0")).rejects.toThrow(
      /headless OAuth required.*GH-847/s,
    );
    expect(calls.length).toBe(1);
  });

  test("headless OAuth signature in claude result text → GH-847 error, no cache write", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-oauth-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-oauth-"));
    const oauthText =
      "Please open this URL in your browser to authorize Notion access:\n" +
      "https://mcp.notion.com/authorize?response_type=code&client_id=foo&code_challenge=bar";
    const { runner, calls } = makeRunner([
      () => ({ stdout: envelope(oauthText) }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-OAUTH-1")).rejects.toThrow(
      /headless OAuth required.*GH-847/s,
    );
    expect(calls.length).toBe(1);
    // GH-867: no cache writes anywhere (XDG dir or worktree).
    expect(existsSync(taskCacheFile(xdg, repoRoot, "PROD-OAUTH-1"))).toBe(false);
    expect(existsSync(join(repoRoot, ".prx/notion-cache/PROD-OAUTH-1.lookup.json"))).toBe(
      false,
    );
  });

  test("headless OAuth signature on stderr with non-zero exit → GH-847 error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-oauth-stderr-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-oauth-stderr-"));
    const stderr =
      "Please open this URL in your browser to authorize Notion access:\n" +
      "https://mcp.notion.com/authorize?response_type=code&client_id=foo";
    const { runner } = makeRunner([
      () => ({ stdout: "", stderr, status: 1 }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROD-OAUTH-2")).rejects.toThrow(
      /headless OAuth required.*GH-847/s,
    );
  });

  test("fetch result with status Done → state closed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-closed-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-closed-"));
    const { runner } = makeRunner([
      () => ({ stdout: envelope('{"pageId": "p", "pageUrl": null}') }),
      () => ({
        stdout: envelope('{"title": "Done thing", "body": null, "state": "closed", "url": null}'),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROD-10");
    expect(resolved.state).toBe("closed");
  });

  test("fetch result parses JSON wrapped in code fences", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-fenced-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-fenced-"));
    const { runner } = makeRunner([
      () => ({
        stdout: envelope(
          '```json\n{"pageId": "p", "pageUrl": null}\n```',
        ),
      }),
      () => ({
        stdout: envelope(
          '```\n{"title": "t", "body": null, "state": "open", "url": null}\n```',
        ),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROD-11");
    expect(resolved.title).toBe("t");
  });

  test("cache file contents are valid JSON matching the unified schema", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-mcp-json-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mcp-xdg-json-"));
    const { runner } = makeRunner([
      () => ({ stdout: envelope('{"pageId": "p123", "pageUrl": "https://u"}') }),
      () => ({
        stdout: envelope('{"title": "T", "body": "B", "state": "open", "url": "https://u"}'),
      }),
    ]);
    const resolver = new NotionClaudeMcpResolver(config, repoRoot, runner, makeEnv(xdg));
    await resolver.fetch("PROD-12");
    const cached = JSON.parse(
      readFileSync(taskCacheFile(xdg, repoRoot, "PROD-12"), "utf8"),
    );
    expect(cached.schemaVersion).toBe(1);
    expect(cached.lookup).toEqual({
      pageId: "p123",
      title: null,
      url: "https://u",
    });
    expect(cached.fetch.title).toBe("T");
    expect(cached.fetch.body).toBe("B");
    expect(cached.fetch.state).toBe("open");
    expect(cached.fetch.url).toBe("https://u");
  });
});
