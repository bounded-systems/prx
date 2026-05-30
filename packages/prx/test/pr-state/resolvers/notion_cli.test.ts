import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotionCliResolver } from "../../../src/pr-state/resolvers/notion_cli.ts";
import type { CommandRunner, NotionIdentityConfig } from "../../../src/pr-state/github.ts";

const config: NotionIdentityConfig = {
  auth: "notion-cli",
  databaseId: null,
  idProperty: null,
  titleProperty: null,
  statusProperty: null,
  tokenOpRef: null,
};

// GH-867: every test gets an isolated XDG_CACHE_HOME so the resolver's new
// `~/.cache/prx/notion/...` writes never touch the operator's real cache.
function makeEnv(xdgCacheHome: string): NodeJS.ProcessEnv {
  return { XDG_CACHE_HOME: xdgCacheHome, HOME: xdgCacheHome };
}

function notionCacheFile(xdgCacheHome: string, id: string): string {
  // GH-867: the cli resolver's `git remote get-url origin` runs through the
  // injected CommandRunner — when the runner only handles `notion-cli`, the
  // git invocation throws, so the resolver falls back to `_anon/<fingerprint>`.
  // The tests reach into that fallback dir to assert cache contents.
  return findAnonNotionCache(xdgCacheHome, id);
}

function findAnonNotionCache(xdgCacheHome: string, id: string): string {
  const anonRoot = join(xdgCacheHome, "prx", "notion", "_anon");
  if (!existsSync(anonRoot)) {
    return join(anonRoot, "missing", `${id}.json`);
  }
  const { readdirSync } = require("node:fs");
  const dirs: string[] = readdirSync(anonRoot);
  for (const d of dirs) {
    const candidate = join(anonRoot, d, `${id}.json`);
    if (existsSync(candidate)) return candidate;
  }
  // No match yet — return a deterministic placeholder pointing at the first
  // dir if any, otherwise a stub.
  if (dirs.length > 0 && dirs[0]) {
    return join(anonRoot, dirs[0], `${id}.json`);
  }
  return join(anonRoot, "missing", `${id}.json`);
}

function makeRunner(
  handlers: Array<(cmd: string[]) => { stdout: string; stderr?: string; status?: number }>,
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const runner: CommandRunner = (cmd) => {
    // GH-867: the resolver now probes `git remote get-url origin` to scope the
    // XDG cache dir per-repo. Stub it as "no remote" so every test falls
    // through to the `_anon/<fingerprint>` branch.
    if (cmd[0] === "git" && cmd.includes("remote")) {
      return { stdout: "", stderr: "no remote", status: 1 };
    }
    calls.push(cmd);
    const handler = handlers[index++];
    if (!handler) {
      throw new Error(`unexpected notion-cli call: ${cmd.join(" ")}`);
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

// ai-home-nki04: shape of `notion-cli page view <id> --json` — the property
// map lives inside the `Content` string's <properties> block.
function pageViewJson(props: Record<string, string>): string {
  return JSON.stringify({
    ID: "ignored-by-verify",
    Title: "ignored-by-verify",
    URL: "ignored-by-verify",
    Content: `Here is the result of "view" for the Page ...\n<properties>\n${JSON.stringify(props)}\n</properties>\n`,
  });
}

function singleResultJson(): string {
  return JSON.stringify([
    {
      ID: "1f0e1234-1234-1234-1234-123456789abc",
      Type: "page",
      Title: "Wire PROJ-5743 — implement checkout retry",
      URL: "https://www.notion.so/demo/Wire-PROJ-5743-1f0e1234",
      ParentType: "database",
      ParentID: "db-1",
    },
  ]);
}

describe("NotionCliResolver", () => {
  test("happy path: spawns notion-cli search with the expected argv and caches the result", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-"));
    const { runner, calls } = makeRunner([() => ({ stdout: singleResultJson() })]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));

    const resolved = await resolver.fetch("PROJ-5743");

    expect(resolved.id).toBe("PROJ-5743");
    expect(resolved.title).toBe("Wire PROJ-5743 — implement checkout retry");
    expect(resolved.body).toBeNull();
    expect(resolved.state).toBe("unknown");
    expect(resolved.url).toBe("https://www.notion.so/demo/Wire-PROJ-5743-1f0e1234");
    expect(resolved.source).toBe("notion");

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      "notion-cli",
      "search",
      "PROJ-5743",
      "--json",
      "--limit",
      "1",
    ]);

    // GH-867: cache lives in the XDG dir under `_anon/<fingerprint>/<id>.json`
    // (no GitHub origin → anon fallback). Unified wrapper format.
    const cachePath = notionCacheFile(xdg, "PROJ-5743");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached).toEqual({
      schemaVersion: 1,
      lookup: {
        pageId: "1f0e1234-1234-1234-1234-123456789abc",
        title: "Wire PROJ-5743 — implement checkout retry",
        url: "https://www.notion.so/demo/Wire-PROJ-5743-1f0e1234",
      },
    });
    // GH-867: nothing under the worktree's .prx anymore.
    expect(existsSync(join(repoRoot, ".prx/notion-cache"))).toBe(false);
  });

  test("cache hit: lookup file present → zero subprocess calls", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-hit-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-hit-"));
    // GH-867: seed a cache hit in the resolved XDG path by triggering one
    // fetch to materialize the directory, then overwrite with cached content.
    const seedRunner = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "p1", Type: "page", Title: "Cached title", URL: "https://notion.so/p1" },
        ]),
      }),
    ]);
    const seeder = new NotionCliResolver(config, repoRoot, seedRunner.runner, makeEnv(xdg));
    await seeder.fetch("PROJ-1");
    const cachePath = notionCacheFile(xdg, "PROJ-1");
    expect(existsSync(cachePath)).toBe(true);

    const { runner, calls } = makeRunner([]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROJ-1");

    expect(resolved.title).toBe("Cached title");
    expect(resolved.url).toBe("https://notion.so/p1");
    expect(calls.length).toBe(0);
  });

  test("corrupted cache file (e.g. {}) → treated as miss, re-spawns notion-cli", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-corrupt-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-corrupt-"));

    // GH-867: pre-populate the XDG dir with a corrupt wrapper. Resolver
    // re-derives the dir via fingerprint — match it by reading the fingerprint
    // dir after a probe write.
    const cacheDir = anonNotionDir(xdg, repoRoot);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "PROJ-CORRUPT.json"), "{}");

    const { runner, calls } = makeRunner([() => ({ stdout: singleResultJson() })]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROJ-CORRUPT");

    expect(resolved.title).toBe("Wire PROJ-5743 — implement checkout retry");
    expect(calls.length).toBe(1);
  });

  test("happy-path stdout containing the substring 'authorization required' is not a false-positive auth error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-false-auth-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-false-auth-"));
    const stdoutWithAuthSubstring = JSON.stringify([
      {
        ID: "page-1",
        Type: "page",
        Title: "Spec: when authorization required, fall back to OAuth",
        URL: "https://www.notion.so/p/page-1",
        ParentType: "database",
        ParentID: "db-1",
      },
    ]);
    const { runner } = makeRunner([
      () => ({ stdout: stdoutWithAuthSubstring, status: 0 }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROJ-FALSE-POS");

    expect(resolved.title).toBe(
      "Spec: when authorization required, fall back to OAuth",
    );
  });

  test("invalidate clears the cache file", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-invalidate-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-invalidate-"));

    // First fetch populates the cache.
    const seedRunner = makeRunner([() => ({ stdout: singleResultJson() })]);
    const seeder = new NotionCliResolver(config, repoRoot, seedRunner.runner, makeEnv(xdg));
    await seeder.fetch("PROJ-2");
    const cachePath = notionCacheFile(xdg, "PROJ-2");
    expect(existsSync(cachePath)).toBe(true);

    // Invalidate uses a fresh resolver instance.
    const { runner: invalidateRunner } = makeRunner([]);
    const invalidator = new NotionCliResolver(
      config,
      repoRoot,
      invalidateRunner,
      makeEnv(xdg),
    );
    invalidator.invalidate("PROJ-2");
    expect(existsSync(cachePath)).toBe(false);

    // Re-fetch re-populates.
    const refetchRunner = makeRunner([() => ({ stdout: singleResultJson() })]);
    const resolver = new NotionCliResolver(
      config,
      repoRoot,
      refetchRunner.runner,
      makeEnv(xdg),
    );
    const resolved = await resolver.fetch("PROJ-2");
    expect(resolved.title).toBe("Wire PROJ-5743 — implement checkout retry");
  });

  test("ENOENT (notion-cli missing on PATH) → remediation error naming home-manager", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-enoent-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-enoent-"));
    const runner: CommandRunner = (cmd) => {
      // git remote probe — stub as a no-remote.
      if (cmd[0] === "git") {
        return { stdout: "", stderr: "", status: 1 };
      }
      const err = new Error("spawn notion-cli ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-3")).rejects.toThrow(
      /`notion-cli` binary not found.*home-manager/,
    );
  });

  test("unauthenticated stderr → remediation error naming `notion-cli auth login`", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-auth-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-auth-"));
    const { runner } = makeRunner([
      () => ({
        stdout: "",
        stderr: "Error: not authenticated. Run `notion-cli auth login` first.",
        status: 1,
      }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-4")).rejects.toThrow(
      /not authenticated.*notion-cli auth login/s,
    );
  });

  test("non-zero exit without auth signal → generic exit-status error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-nonzero-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-nonzero-"));
    const { runner } = makeRunner([
      () => ({ stdout: "", stderr: "boom", status: 2 }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-5")).rejects.toThrow(
      /notion-cli exited with status 2.*boom/s,
    );
  });

  test("empty results array → clear no-match error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-empty-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-empty-"));
    const { runner } = makeRunner([() => ({ stdout: "[]\n" })]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-NOPE")).rejects.toThrow(
      /no Notion row matches "PROJ-NOPE"/,
    );
  });

  test("null stdout (Go nil-slice JSON) → treated as empty results", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-null-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-null-"));
    const { runner } = makeRunner([() => ({ stdout: "null\n" })]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-NIL")).rejects.toThrow(
      /no Notion row matches "PROJ-NIL"/,
    );
  });

  test("malformed JSON stdout → clear parse error including stdout snippet", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-bad-json-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-bad-json-"));
    const { runner } = makeRunner([
      () => ({ stdout: "not json at all" }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-X")).rejects.toThrow(
      /could not parse --json output/,
    );
  });

  test("result missing ID field → clear error", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-missing-id-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-missing-id-"));
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([{ Type: "page", Title: "no id", URL: "" }]),
      }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    await expect(resolver.fetch("PROJ-Z")).rejects.toThrow(/missing "ID" field/);
  });

  test("result missing URL field → resolved.url is null", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-no-url-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-no-url-"));
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "p1", Type: "page", Title: "T", URL: "" },
        ]),
      }),
    ]);
    const resolver = new NotionCliResolver(config, repoRoot, runner, makeEnv(xdg));
    const resolved = await resolver.fetch("PROJ-Q");
    expect(resolved.url).toBeNull();
  });

  // ai-home-nki04: with `id_property` configured, the resolver verifies each
  // candidate via `page view` and accepts only the exact id-property match.
  test("verify path: exact id_property match wins even when it is not the first search hit", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-verify-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-verify-"));
    const verifyConfig: NotionIdentityConfig = {
      ...config,
      idProperty: "Task ID",
      statusProperty: "Status",
      closedStatuses: ["Completed", "DNF - Did not Complete"],
    };
    const { runner, calls } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "page-A", Type: "page", Title: "Decoy", URL: "https://notion.so/page-A" },
          {
            ID: "page-B",
            Type: "page",
            Title: "Tactical API: 400 Sorry Bad Request",
            URL: "https://notion.so/page-B",
          },
        ]),
      }),
      () => ({ stdout: pageViewJson({ "Task ID": "PROJ-9999" }) }),
      () => ({
        stdout: pageViewJson({ "Task ID": "PROJ-5966", Status: "In Progress" }),
      }),
    ]);
    const resolver = new NotionCliResolver(verifyConfig, repoRoot, runner, makeEnv(xdg));

    const resolved = await resolver.fetch("PROJ-5966");

    expect(resolved.url).toBe("https://notion.so/page-B");
    expect(resolved.title).toBe("Tactical API: 400 Sorry Bad Request");
    expect(resolved.source).toBe("notion");
    // "In Progress" is not in closed_statuses → open.
    expect(resolved.state).toBe("open");
    expect(calls[0]).toEqual([
      "notion-cli",
      "search",
      "PROJ-5966",
      "--json",
      "--limit",
      "5",
    ]);
    expect(calls[1]).toEqual(["notion-cli", "page", "view", "page-A", "--json"]);
    expect(calls[2]).toEqual(["notion-cli", "page", "view", "page-B", "--json"]);
  });

  test("verify path: no candidate matches id_property → exact-match error (no silent wrong page)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-verify-none-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-verify-none-"));
    const verifyConfig: NotionIdentityConfig = {
      ...config,
      idProperty: "Task ID",
      statusProperty: "Status",
      closedStatuses: ["Completed", "DNF - Did not Complete"],
    };
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "page-A", Type: "page", Title: "Decoy", URL: "https://notion.so/page-A" },
        ]),
      }),
      () => ({ stdout: pageViewJson({ "Task ID": "PROJ-1" }) }),
    ]);
    const resolver = new NotionCliResolver(verifyConfig, repoRoot, runner, makeEnv(xdg));

    await expect(resolver.fetch("PROJ-5966")).rejects.toThrow(
      /no Notion row where Task ID == "PROJ-5966"/,
    );
  });

  test("verify path: a Status in closed_statuses maps state to closed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-verify-closed-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-verify-closed-"));
    const verifyConfig: NotionIdentityConfig = {
      ...config,
      idProperty: "Task ID",
      statusProperty: "Status",
      closedStatuses: ["Completed", "DNF - Did not Complete"],
    };
    const { runner } = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "page-B", Type: "page", Title: "Done thing", URL: "https://notion.so/page-B" },
        ]),
      }),
      () => ({ stdout: pageViewJson({ "Task ID": "PROJ-42", Status: "Completed" }) }),
    ]);
    const resolver = new NotionCliResolver(verifyConfig, repoRoot, runner, makeEnv(xdg));

    const resolved = await resolver.fetch("PROJ-42");

    expect(resolved.state).toBe("closed");
  });

  test("verify path cache hit: skips search, re-reads Status fresh via page view", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-cli-verify-hit-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-cli-xdg-verify-hit-"));
    const verifyConfig: NotionIdentityConfig = {
      ...config,
      idProperty: "Task ID",
      statusProperty: "Status",
      closedStatuses: ["Completed", "DNF - Did not Complete"],
    };
    // Seed: search + page view populate the lookup cache (status open).
    const seedRunner = makeRunner([
      () => ({
        stdout: JSON.stringify([
          { ID: "page-B", Type: "page", Title: "T", URL: "https://notion.so/page-B" },
        ]),
      }),
      () => ({ stdout: pageViewJson({ "Task ID": "PROJ-7", Status: "Backlog" }) }),
    ]);
    const seeder = new NotionCliResolver(
      verifyConfig,
      repoRoot,
      seedRunner.runner,
      makeEnv(xdg),
    );
    const seeded = await seeder.fetch("PROJ-7");
    expect(seeded.state).toBe("open");

    // Hit: lookup cached → no search; Status has since moved to Completed, and
    // the resolver re-reads it fresh via a single page view.
    const { runner, calls } = makeRunner([
      () => ({ stdout: pageViewJson({ "Task ID": "PROJ-7", Status: "Completed" }) }),
    ]);
    const resolver = new NotionCliResolver(verifyConfig, repoRoot, runner, makeEnv(xdg));

    const resolved = await resolver.fetch("PROJ-7");

    expect(resolved.state).toBe("closed");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["notion-cli", "page", "view", "page-B", "--json"]);
  });
});

// GH-867: derive the resolver's anon-fallback cache dir without re-importing
// resolveNotionCacheDir — the tests should pin the path independently of the
// helper they exercise.
function anonNotionDir(xdgCacheHome: string, repoRoot: string): string {
  const { createHash } = require("node:crypto");
  const { resolve } = require("node:path");
  const fingerprint = createHash("sha256")
    .update(resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return join(xdgCacheHome, "prx", "notion", "_anon", fingerprint);
}
