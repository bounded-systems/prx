import { processEnv } from "@bounded-systems/env";
import { join } from "node:path";

import { type CommandRunner, type NotionIdentityConfig, defaultRunner } from "../github.ts";
import { resolveNotionCacheDir } from "../../tools/cache_path.ts";
import {
  invalidateEntireTask,
  mergeLookup,
  type NotionLookup,
  readTaskCache,
} from "./notion_cache.ts";
import type { ResolvedWorkUnit, WorkUnitResolver } from "./types.ts";

type SearchResultJson = {
  ID?: unknown;
  Type?: unknown;
  Title?: unknown;
  URL?: unknown;
};

const NOT_AUTHENTICATED_PATTERNS = [
  /not authenticated/i,
  /not logged in/i,
  /authorization required/i,
  /run.*auth login/i,
];

function looksLikeAuthFailure(text: string): boolean {
  return NOT_AUTHENTICATED_PATTERNS.some((re) => re.test(text));
}

// ai-home-nki04: how many search candidates to fetch+verify before giving up.
// Search is fuzzy/ranked; the exact id-property match is usually rank #1, but
// fetching a small window guards against a higher-ranked near-miss.
const VERIFY_SEARCH_LIMIT = 5;

export class NotionCliResolver implements WorkUnitResolver {
  readonly name = "notion" as const;

  constructor(
    private readonly config: NotionIdentityConfig,
    private readonly repoRoot: string,
    private readonly runner: CommandRunner = defaultRunner,
    private readonly env: NodeJS.ProcessEnv = processEnv(),
  ) {}

  async fetch(canonicalId: string): Promise<ResolvedWorkUnit> {
    let lookup = this.readLookupCache(canonicalId);
    let state: ResolvedWorkUnit["state"] = "unknown";
    if (!lookup) {
      // ai-home-nki04: when the source declares an `id_property`, resolve
      // EXACTLY — `notion-cli search` is fuzzy/ranked, so we fetch each
      // candidate and accept only the page whose canonical-id property equals
      // `canonicalId`. Without an `id_property` configured, fall back to the
      // legacy first-hit behaviour (other notion-cli sources are unaffected).
      if (this.config.idProperty) {
        const verified = this.searchAndVerify(canonicalId, this.config.idProperty);
        lookup = verified.lookup;
        state = verified.state;
      } else {
        lookup = this.searchForPage(canonicalId);
      }
      this.writeLookupCache(canonicalId, lookup);
    } else if (this.canMapState()) {
      // Cache hit: the id→page mapping is stable (cached), but Status is
      // mutable — read it fresh rather than serving a point-in-time value.
      state = this.stateFromPage(lookup.pageId);
    }
    return {
      id: canonicalId,
      title: lookup.title ?? canonicalId,
      body: null,
      state,
      url: lookup.url,
      source: "notion",
    };
  }

  invalidate(canonicalId: string): void {
    invalidateEntireTask(this.taskCachePath(canonicalId));
  }

  private cacheDir(): string {
    return resolveNotionCacheDir({
      repoRoot: this.repoRoot,
      env: this.env,
      runner: this.runner,
    });
  }

  private taskCachePath(canonicalId: string): string {
    return join(this.cacheDir(), `${canonicalId}.json`);
  }

  private readLookupCache(canonicalId: string): NotionLookup | null {
    const cache = readTaskCache(this.taskCachePath(canonicalId));
    return cache?.lookup ?? null;
  }

  private writeLookupCache(canonicalId: string, value: NotionLookup): void {
    mergeLookup(this.taskCachePath(canonicalId), value);
  }

  // Spawn `notion-cli <args>` and return stdout, mapping the substrate's
  // failure modes (missing binary / unauthenticated / non-zero exit) to typed
  // remediation errors. Shared by the search and page-view legs.
  private runNotionCli(args: string[]): string {
    let result;
    try {
      result = this.runner(["notion-cli", ...args], { check: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(
          "notion-cli resolver: `notion-cli` binary not found on PATH. Install via home-manager (programs.notion-cli.enable = true) and run `home-manager switch`.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`notion-cli resolver: failed to spawn notion-cli: ${message}`);
    }
    if (result.status !== 0) {
      if (looksLikeAuthFailure(`${result.stderr}\n${result.stdout}`)) {
        throw new Error(
          "notion-cli resolver: notion-cli is not authenticated. Run: notion-cli auth login",
        );
      }
      throw new Error(
        `notion-cli resolver: notion-cli exited with status ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout;
  }

  private runSearch(canonicalId: string, limit: number): SearchResultJson[] {
    const stdout = this.runNotionCli(["search", canonicalId, "--json", "--limit", String(limit)]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `notion-cli resolver: could not parse --json output (${message}). stdout was: ${stdout.slice(0, 200)}`,
      );
    }
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      throw new Error(
        `notion-cli resolver: --json output was not an array. got: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    return parsed as SearchResultJson[];
  }

  // Legacy first-hit resolution (no `id_property` configured): trust the
  // top-ranked search result. Fragile, but preserved for sources that have
  // not opted into exact verification.
  private searchForPage(canonicalId: string): NotionLookup {
    const results = this.runSearch(canonicalId, 1);
    if (results.length === 0) {
      throw new Error(
        `notion-cli resolver: no Notion row matches "${canonicalId}". Check that the row exists and that "${canonicalId}" appears in its searchable fields (e.g. Internal ID).`,
      );
    }
    const first = results[0]!;
    if (typeof first.ID !== "string" || first.ID.length === 0) {
      throw new Error(
        `notion-cli resolver: search result missing "ID" field. got: ${JSON.stringify(first).slice(0, 200)}`,
      );
    }
    const title = typeof first.Title === "string" ? first.Title : canonicalId;
    const url = typeof first.URL === "string" && first.URL.length > 0 ? first.URL : null;
    return { pageId: first.ID, title, url };
  }

  // ai-home-nki04: exact resolution. Search narrows; `page view` + property
  // comparison verifies. Accept only the candidate whose `idProperty` equals
  // `canonicalId` exactly; never silently return a ranked near-miss.
  private searchAndVerify(
    canonicalId: string,
    idProperty: string,
  ): { lookup: NotionLookup; state: ResolvedWorkUnit["state"] } {
    const results = this.runSearch(canonicalId, VERIFY_SEARCH_LIMIT);
    for (const result of results) {
      if (typeof result.ID !== "string" || result.ID.length === 0) continue;
      const properties = this.fetchPageProperties(result.ID);
      if (!properties) continue;
      if (properties[idProperty] === canonicalId) {
        const title = typeof result.Title === "string" ? result.Title : canonicalId;
        const url = typeof result.URL === "string" && result.URL.length > 0 ? result.URL : null;
        return {
          lookup: { pageId: result.ID, title, url },
          state: this.mapState(properties),
        };
      }
    }
    throw new Error(
      `notion-cli resolver: no Notion row where ${idProperty} == "${canonicalId}" among the top ${results.length} search hit(s). The id property must match exactly — check the row exists and "${canonicalId}" is its ${idProperty}.`,
    );
  }

  // ai-home-nki04: map a page's Status property to open/closed using the
  // source's configured `closed_statuses`. Returns "unknown" unless both a
  // status property and a non-empty closed-status set are configured.
  private canMapState(): boolean {
    return Boolean(
      this.config.idProperty &&
        this.config.statusProperty &&
        (this.config.closedStatuses?.length ?? 0) > 0,
    );
  }

  private mapState(properties: Record<string, unknown>): ResolvedWorkUnit["state"] {
    const statusProperty = this.config.statusProperty;
    const closed = this.config.closedStatuses ?? [];
    if (!statusProperty || closed.length === 0) return "unknown";
    const value = properties[statusProperty];
    if (typeof value !== "string" || value.length === 0) return "unknown";
    return closed.includes(value) ? "closed" : "open";
  }

  private stateFromPage(pageId: string): ResolvedWorkUnit["state"] {
    const properties = this.fetchPageProperties(pageId);
    return properties ? this.mapState(properties) : "unknown";
  }

  // Fetch a page and pull its property map out of the `notion-cli page view`
  // payload. `page view --json` embeds the <properties>{…}</properties> block
  // inside the `Content` string (Notion-flavoured markdown). Returns null on
  // any shape mismatch so the caller can skip the candidate.
  private fetchPageProperties(pageId: string): Record<string, unknown> | null {
    const stdout = this.runNotionCli(["page", "view", pageId, "--json"]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const content = (parsed as { Content?: unknown }).Content;
    if (typeof content !== "string") return null;
    const match = content.match(/<properties>([\s\S]*?)<\/properties>/);
    if (!match || !match[1]) return null;
    try {
      const props = JSON.parse(match[1].trim());
      return typeof props === "object" && props !== null
        ? (props as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
