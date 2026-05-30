import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  migrateLegacyNotionCache,
  resolveCacheRoot,
  resolveNotionCacheDir,
} from "../../src/tools/cache_path.ts";
import type { CommandRunner } from "../../src/pr-state/github.ts";

function makeOriginRunner(originUrl: string | null): CommandRunner {
  return (cmd) => {
    if (cmd[0] === "git" && cmd.includes("remote") && cmd.includes("get-url")) {
      if (originUrl === null) {
        return { stdout: "", stderr: "no remote", status: 1 };
      }
      return { stdout: `${originUrl}\n`, stderr: "", status: 0 };
    }
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
}

describe("resolveCacheRoot", () => {
  test("XDG_CACHE_HOME wins when set", () => {
    const result = resolveCacheRoot({
      XDG_CACHE_HOME: "/custom/cache",
      HOME: "/home/test",
    });
    expect(result.source).toBe("XDG_CACHE_HOME");
    expect(result.root).toBe("/custom/cache/prx");
  });

  test("falls back to ${HOME}/.cache/prx when XDG_CACHE_HOME absent", () => {
    const result = resolveCacheRoot({ HOME: "/home/test" });
    expect(result.source).toBe("HOME");
    expect(result.root).toBe("/home/test/.cache/prx");
  });

  test("falls back to /tmp/.cache/prx when neither set", () => {
    const result = resolveCacheRoot({});
    expect(result.source).toBe("default");
    expect(result.root).toBe("/tmp/.cache/prx");
  });
});

describe("resolveNotionCacheDir", () => {
  test("ssh origin (git@github.com:owner/repo.git) → owner/name path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-ssh-"));
    const xdg = "/cache";
    const dir = resolveNotionCacheDir({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: "/h" },
      runner: makeOriginRunner("git@github.com:bdelanghe/ai-home.git"),
    });
    expect(dir).toBe("/cache/prx/notion/bdelanghe/ai-home");
  });

  test("https origin (https://github.com/owner/repo) → identical owner/name path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-https-"));
    const xdg = "/cache";
    const dir = resolveNotionCacheDir({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: "/h" },
      runner: makeOriginRunner("https://github.com/bdelanghe/ai-home"),
    });
    expect(dir).toBe("/cache/prx/notion/bdelanghe/ai-home");
  });

  test("non-github origin falls back to _anon/<8-hex>", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-anon-"));
    const xdg = "/cache";
    const dir = resolveNotionCacheDir({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: "/h" },
      runner: makeOriginRunner("https://gitlab.com/foo/bar.git"),
    });
    const fingerprint = createHash("sha256")
      .update(resolve(repoRoot))
      .digest("hex")
      .slice(0, 8);
    expect(dir).toBe(`/cache/prx/notion/_anon/${fingerprint}`);
  });

  test("missing origin falls back to _anon/<8-hex>", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-notion-no-origin-"));
    const xdg = "/cache";
    const dir = resolveNotionCacheDir({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: "/h" },
      runner: makeOriginRunner(null),
    });
    expect(dir).toMatch(/^\/cache\/prx\/notion\/_anon\/[0-9a-f]{8}$/);
  });
});

describe("migrateLegacyNotionCache", () => {
  test("no legacy dir → { migrated: 0 }, no-op", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-mig-empty-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mig-empty-xdg-"));
    const result = migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner(null),
    });
    expect(result.migrated).toBe(0);
    // GH-867: target XDG dir is not created when there's nothing to migrate.
    expect(existsSync(join(xdg, "prx", "notion"))).toBe(false);
  });

  test("mix of .notion-cli.json + .lookup.json + .fetch.json merges into one unified file with both halves", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-mig-mix-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mig-mix-xdg-"));

    const legacyDir = join(repoRoot, ".prx", "notion-cache");
    mkdirSync(legacyDir, { recursive: true });
    // notion-cli legacy shape for task FOO-1
    writeFileSync(
      join(legacyDir, "FOO-1.notion-cli.json"),
      JSON.stringify({ pageId: "p-foo", title: "Foo title", url: "https://x/foo" }),
    );
    // notion-claude-mcp legacy lookup + fetch for task BAR-2
    writeFileSync(
      join(legacyDir, "BAR-2.lookup.json"),
      JSON.stringify({ pageId: "p-bar", pageUrl: "https://x/bar" }),
    );
    writeFileSync(
      join(legacyDir, "BAR-2.fetch.json"),
      JSON.stringify({
        title: "Bar title",
        body: "bar body",
        state: "open",
        url: "https://x/bar",
      }),
    );

    const result = migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner("https://github.com/bdelanghe/ai-home"),
    });

    expect(result.migrated).toBe(3);

    // GH-867: legacy dir is gone.
    expect(existsSync(legacyDir)).toBe(false);
    // GH-867: .prx itself stays (it has no other contents in this test, but
    // the migration should not remove it). rmdir of the empty .prx is out of
    // scope per the plan — leave alone.
    expect(existsSync(join(repoRoot, ".prx"))).toBe(true);

    const xdgDir = join(xdg, "prx", "notion", "bdelanghe", "ai-home");
    expect(existsSync(join(xdgDir, "FOO-1.json"))).toBe(true);
    expect(existsSync(join(xdgDir, "BAR-2.json"))).toBe(true);

    const foo = JSON.parse(readFileSync(join(xdgDir, "FOO-1.json"), "utf8"));
    expect(foo).toEqual({
      schemaVersion: 1,
      lookup: { pageId: "p-foo", title: "Foo title", url: "https://x/foo" },
    });

    const bar = JSON.parse(readFileSync(join(xdgDir, "BAR-2.json"), "utf8"));
    expect(bar.schemaVersion).toBe(1);
    expect(bar.lookup).toEqual({
      pageId: "p-bar",
      title: null,
      url: "https://x/bar",
    });
    expect(bar.fetch.title).toBe("Bar title");
    expect(bar.fetch.body).toBe("bar body");
    expect(bar.fetch.state).toBe("open");
    expect(bar.fetch.url).toBe("https://x/bar");
  });

  test("idempotent: second invocation is a no-op", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-mig-idem-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mig-idem-xdg-"));

    const legacyDir = join(repoRoot, ".prx", "notion-cache");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "IDEM-1.notion-cli.json"),
      JSON.stringify({ pageId: "p", title: "t", url: null }),
    );

    const first = migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner(null),
    });
    expect(first.migrated).toBe(1);

    const second = migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner(null),
    });
    expect(second.migrated).toBe(0);
  });

  test(".prx is left alone when it still contains other operator state", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-mig-coexist-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mig-coexist-xdg-"));

    const legacyDir = join(repoRoot, ".prx", "notion-cache");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "TASK.notion-cli.json"),
      JSON.stringify({ pageId: "p", title: "t", url: null }),
    );
    // Other operator state under .prx/.
    mkdirSync(join(repoRoot, ".prx", "repos"), { recursive: true });
    writeFileSync(join(repoRoot, ".prx", "repos", "keep.json"), "{}");

    migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner(null),
    });

    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(join(repoRoot, ".prx", "repos", "keep.json"))).toBe(true);
  });

  test("corrupt legacy file → skipped, other files still migrate", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prx-mig-corrupt-"));
    const xdg = mkdtempSync(join(tmpdir(), "prx-mig-corrupt-xdg-"));

    const legacyDir = join(repoRoot, ".prx", "notion-cache");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "BAD.notion-cli.json"), "not json{");
    writeFileSync(
      join(legacyDir, "GOOD.notion-cli.json"),
      JSON.stringify({ pageId: "p", title: "t", url: null }),
    );

    const result = migrateLegacyNotionCache({
      repoRoot,
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      runner: makeOriginRunner(null),
    });
    expect(result.migrated).toBe(1);

    // Find the anon dir.
    const anonRoot = join(xdg, "prx", "notion", "_anon");
    const dirs = readdirSync(anonRoot);
    expect(dirs.length).toBe(1);
    const fingerprintDir = join(anonRoot, dirs[0]!);
    expect(existsSync(join(fingerprintDir, "GOOD.json"))).toBe(true);
    expect(existsSync(join(fingerprintDir, "BAD.json"))).toBe(false);
  });
});
