// GH-867 — operator-state cache root resolution.
//
// Notion resolver cache files (and, in follow-ups, other `.prx/` operator
// state) should live under `$XDG_CACHE_HOME/prx/...` rather than inside the
// repo's worktree. `resolveCacheRoot()` is the generic XDG resolver;
// `resolveNotionCacheDir()` composes onto it for the Notion resolvers; and
// `migrateLegacyNotionCache()` is the one-shot session-entry migration.
//
// Shape mirrors `src/tools/worktree_path.ts:63` so future `.prx/` consumers
// (`.prx/repos/`, `.prx/branch_protection/`, `.prx/dep-research/`) can land as
// small follow-up composers without rewriting XDG logic.

import { processEnv } from "@bounded-systems/env";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { type CommandRunner, defaultRunner } from "../pr-state/github.ts";
import { parseRepoUrl } from "../pr-state/repos.ts";
import {
  mergeFetch,
  mergeLookup,
  type NotionFetch,
  type NotionLookup,
} from "../pr-state/resolvers/notion_cache.ts";
import { appendAuditRow } from "../audit/sink.ts";

// GH-867: shape is structurally NodeJS.ProcessEnv-compatible — callers pass
// `processEnv()` directly. The explicit type makes test stubs ergonomic.
export type CachePathEnv =
  | NodeJS.ProcessEnv
  | {
      XDG_CACHE_HOME?: string | undefined;
      HOME?: string | undefined;
    };

export type CacheRootResult = {
  /** The resolved cache root: `${XDG_CACHE_HOME ?? ${HOME}/.cache}/prx`. */
  root: string;
  source: "XDG_CACHE_HOME" | "HOME" | "default";
};

/**
 * Resolve `$XDG_CACHE_HOME/prx` (default `${HOME}/.cache/prx`, default
 * `/tmp/.cache/prx` when neither is set).
 */
export function resolveCacheRoot(
  env: CachePathEnv = processEnv() as CachePathEnv,
): CacheRootResult {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg && xdg.length > 0) {
    return { root: join(xdg, "prx"), source: "XDG_CACHE_HOME" };
  }
  if (env.HOME) {
    return { root: join(env.HOME, ".cache", "prx"), source: "HOME" };
  }
  return { root: join("/tmp", ".cache", "prx"), source: "default" };
}

export type NotionCacheDirDeps = {
  repoRoot: string;
  env?: CachePathEnv;
  runner?: CommandRunner;
};

/**
 * Resolve the per-repo Notion cache directory:
 *   `${cacheRoot}/notion/${owner}/${name}/`
 *
 * Reads the `origin` remote via `git remote get-url origin` and parses with
 * `parseRepoUrl`. When the origin is non-GitHub or missing, falls back to
 * `${cacheRoot}/notion/_anon/${sha256(repoRoot):0..8}/` so the cache is still
 * scoped per-repo without colliding between checkouts.
 */
export function resolveNotionCacheDir(deps: NotionCacheDirDeps): string {
  const env = deps.env ?? (processEnv() as CachePathEnv);
  const runner = deps.runner ?? defaultRunner;
  const { root } = resolveCacheRoot(env);

  let originUrl: string | null = null;
  try {
    const result = runner(["git", "-C", deps.repoRoot, "remote", "get-url", "origin"], {
      check: false,
    });
    if (result.status === 0) {
      const trimmed = result.stdout.trim();
      originUrl = trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    originUrl = null;
  }

  const parsed = originUrl ? parseRepoUrl(originUrl) : null;
  if (parsed && parsed.host === "github.com") {
    return join(root, "notion", parsed.owner, parsed.name);
  }

  const fingerprint = createHash("sha256").update(resolve(deps.repoRoot)).digest("hex").slice(0, 8);
  return join(root, "notion", "_anon", fingerprint);
}

const LEGACY_SUFFIXES = [".notion-cli.json", ".lookup.json", ".fetch.json"] as const;

function stripLegacySuffix(name: string): { taskId: string; suffix: string } {
  for (const suffix of LEGACY_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return { taskId: name.slice(0, -suffix.length), suffix };
    }
  }
  return { taskId: name.replace(/\.json$/, ""), suffix: "" };
}

export type MigrateLegacyNotionCacheDeps = {
  repoRoot: string;
  env?: CachePathEnv;
  runner?: CommandRunner;
};

export type MigrateLegacyNotionCacheResult = {
  migrated: number;
};

/**
 * One-shot migration of `<repoRoot>/.prx/notion-cache/` into the XDG cache
 * directory. Idempotent: second invocation is a no-op because the legacy dir
 * is removed once empty. Safe to call before every session-entry dispatch.
 *
 * Filename → unified-shape mapping:
 *   - `<id>.notion-cli.json` { pageId, title, url }       → lookup half
 *   - `<id>.lookup.json`     { pageId, pageUrl }          → lookup half
 *   - `<id>.fetch.json`      { title, body, state, url }  → fetch half
 */
export function migrateLegacyNotionCache(
  deps: MigrateLegacyNotionCacheDeps,
): MigrateLegacyNotionCacheResult {
  const legacyDir = join(deps.repoRoot, ".prx", "notion-cache");
  if (!existsSync(legacyDir)) {
    return { migrated: 0 };
  }

  const targetDir = resolveNotionCacheDir(deps);
  mkdirSync(targetDir, { recursive: true });

  const entries = readdirSync(legacyDir, { withFileTypes: true });
  let migrated = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const legacyPath = join(legacyDir, entry.name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch {
      try {
        unlinkSync(legacyPath);
      } catch {
        // ignore
      }
      continue;
    }

    const { taskId, suffix } = stripLegacySuffix(entry.name);
    const targetFile = join(targetDir, `${taskId}.json`);

    if (suffix === ".fetch.json") {
      const fetched = coerceLegacyFetch(raw);
      if (fetched) {
        mergeFetch(targetFile, fetched);
        migrated += 1;
      }
    } else {
      const lookup = coerceLegacyLookup(raw);
      if (lookup) {
        mergeLookup(targetFile, lookup);
        migrated += 1;
      }
    }

    try {
      unlinkSync(legacyPath);
    } catch {
      // best-effort
    }
  }

  // Remove the now-empty `notion-cache/` dir. `.prx/` itself stays because
  // other operator-state consumers (repos/, branch_protection/, dep-research/)
  // still live there. `rmdirSync` throws when the dir is non-empty — swallow.
  try {
    rmdirSync(legacyDir);
  } catch {
    // ignore
  }

  if (migrated > 0) {
    try {
      appendAuditRow({
        ts: new Date().toISOString(),
        kind: "notion-cache-migrated",
        count: migrated,
        targetDir,
        actor: "claude-code",
      });
    } catch {
      // sink-side failure is non-fatal — files have already been migrated
    }
  }

  return { migrated };
}

function coerceLegacyLookup(raw: unknown): NotionLookup | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pageId !== "string" || obj.pageId.length === 0) return null;

  // notion-cli legacy stored `url`; notion-claude-mcp legacy stored `pageUrl`.
  const url =
    typeof obj.url === "string" ? obj.url : typeof obj.pageUrl === "string" ? obj.pageUrl : null;
  const title = typeof obj.title === "string" ? obj.title : null;
  return { pageId: obj.pageId, title, url };
}

function coerceLegacyFetch(raw: unknown): NotionFetch | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string") return null;
  const body = typeof obj.body === "string" ? obj.body : null;
  const stateRaw = typeof obj.state === "string" ? obj.state : "unknown";
  const state: "open" | "closed" | "unknown" =
    stateRaw === "open" || stateRaw === "closed" ? stateRaw : "unknown";
  const url = typeof obj.url === "string" ? obj.url : null;
  return {
    title: obj.title,
    body,
    state,
    url,
    fetchedAt: new Date(0).toISOString(),
  };
}
