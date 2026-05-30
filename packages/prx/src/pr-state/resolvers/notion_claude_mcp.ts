import { processEnv } from "@bounded-systems/env";
import { join } from "node:path";

import {
  type CommandRunner,
  type NotionIdentityConfig,
  defaultRunner,
} from "../github.ts";
import { parseClaudeJsonEnvelope } from "../../claude/envelope.ts";
import { resolveNotionCacheDir } from "../../tools/cache_path.ts";
import {
  invalidateFetchField,
  mergeFetch,
  mergeLookup,
  type NotionFetch,
  type NotionLookup,
  readTaskCache,
} from "./notion_cache.ts";
import type {
  NotionPageLookup,
  NotionPageResolver,
  ResolvedWorkUnit,
} from "./types.ts";

// Hyphenated or unhyphenated 32-hex Notion page UUID — short-circuits the
// notion-search lookup when scout passes a UUID directly (GH-1420).
const NOTION_PAGE_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const DEFAULT_MODEL = "claude-sonnet-4-6";

const HEADLESS_OAUTH_INSTRUCTION =
  "Please open this URL in your browser to authorize";
const HEADLESS_OAUTH_AUTHORIZE_URL_PREFIX = "https://mcp.notion.com/authorize";

export type HeadlessOAuthDetection = { authorizeUrl: string };

export function detectHeadlessOAuthRequired(
  text: string,
): HeadlessOAuthDetection | null {
  if (!text || !text.includes(HEADLESS_OAUTH_INSTRUCTION)) {
    return null;
  }
  const idx = text.indexOf(HEADLESS_OAUTH_AUTHORIZE_URL_PREFIX);
  if (idx < 0) {
    return null;
  }
  const tail = text.slice(idx);
  const ws = tail.search(/\s/);
  const authorizeUrl = ws < 0 ? tail : tail.slice(0, ws);
  return { authorizeUrl };
}

export function headlessOAuthError(
  detection: HeadlessOAuthDetection,
): Error {
  const urlPreview = detection.authorizeUrl.slice(0, 120);
  return new Error(
    [
      "claude MCP resolver: headless OAuth required (GH-847).",
      `claude --print emitted a Notion OAuth authorization URL (${urlPreview}) — --print mode cannot complete the flow:`,
      "  - claude --print does not reuse the interactive Claude Code Notion OAuth credential",
      "  - the printed URL omits redirect_uri (Notion rejects it)",
      "  - --print has no local callback listener",
      'Remediation: run `prx preflight notion` to confirm; provision a Notion integration token and switch the overlay to `auth = "rest"` if blocked. Tracking: GH-847.',
    ].join("\n"),
  );
}

function claudeModel(env: NodeJS.ProcessEnv): string {
  return env.PRX_NOTION_MCP_MODEL ?? DEFAULT_MODEL;
}

function parseClaudeResult(stdout: string): string {
  // GH-1095: lifted to `src/claude/envelope.ts`. Keeps the historical
  // `claude MCP resolver:` error prefix so log greps continue to match.
  return parseClaudeJsonEnvelope(stdout, "claude MCP resolver").result;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through — claude sometimes wraps in code fences or prose
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      // fall through
    }
  }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      return JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
    } catch (error) {
      throw new Error(
        `claude MCP resolver: could not parse JSON payload from claude result: ${(error as Error).message}`,
      );
    }
  }
  throw new Error(
    `claude MCP resolver: claude result did not contain JSON. result was: ${trimmed.slice(0, 200)}`,
  );
}

const LOOKUP_PROMPT = (id: string) =>
  `You have access to the Notion MCP server. Call notion-search with the exact query "${id}" to find the Notion page whose canonical ID matches. Return ONLY strict JSON with this shape and nothing else: {"pageId": "<notion page id>", "pageUrl": "<page url or null>"}. Do not include any prose, commentary, or code fences. If no page matches, return {"error": "not_found"}. If multiple pages match, pick the one whose title or ID property most precisely equals "${id}".`;

const FETCH_PROMPT = (pageId: string) =>
  `You have access to the Notion MCP server. Call notion-fetch with id="${pageId}" to retrieve the page. Return ONLY strict JSON with this shape and nothing else: {"title": "<page title>", "body": "<plain-text body or null>", "state": "open"|"closed"|"unknown", "url": "<page url or null>"}. "state" should be "closed" if the page's Status property equals "Done", "Complete", "Completed", or "Closed"; "open" if Status has any other non-empty value; "unknown" if there is no Status property. Do not include any prose, commentary, or code fences.`;

export class NotionClaudeMcpResolver implements NotionPageResolver {
  readonly name = "notion" as const;

  constructor(
    private readonly config: NotionIdentityConfig,
    private readonly repoRoot: string,
    private readonly runner: CommandRunner = defaultRunner,
    private readonly env: NodeJS.ProcessEnv = processEnv(),
  ) {}

  async fetch(canonicalId: string): Promise<ResolvedWorkUnit> {
    void this.config;
    let lookup = this.readLookupCache(canonicalId);
    if (!lookup) {
      lookup = this.searchForPage(canonicalId);
      this.writeLookupCache(canonicalId, lookup);
    }
    let fetched = this.readFetchCache(canonicalId);
    if (!fetched) {
      fetched = this.fetchPage(lookup.pageId);
      this.writeFetchCache(canonicalId, fetched);
    }
    return {
      id: canonicalId,
      title: fetched.title,
      body: fetched.body,
      state: fetched.state,
      url: fetched.url ?? lookup.url ?? null,
      source: "notion",
    };
  }

  // GH-1420: surface the canonical Notion page UUID to scout. UUID inputs
  // skip the notion-search round-trip; Task-ID inputs reuse the lookup cache
  // populated by `searchForPage`.
  async findPageId(canonicalId: string): Promise<NotionPageLookup> {
    if (NOTION_PAGE_UUID.test(canonicalId)) {
      return { pageId: canonicalId, pageUrl: null };
    }
    let lookup = this.readLookupCache(canonicalId);
    if (!lookup) {
      lookup = this.searchForPage(canonicalId);
      this.writeLookupCache(canonicalId, lookup);
    }
    return { pageId: lookup.pageId, pageUrl: lookup.url };
  }

  // GH-1420: fetch a page by its Notion UUID, bypassing the canonical-id
  // lookup. Cache is keyed on the pageId so repeated UUID resolutions stay
  // hot across runs.
  async fetchByPageId(pageId: string): Promise<ResolvedWorkUnit> {
    void this.config;
    let fetched = this.readFetchCache(pageId);
    if (!fetched) {
      fetched = this.fetchPage(pageId);
      this.writeFetchCache(pageId, fetched);
    }
    return {
      id: pageId,
      title: fetched.title,
      body: fetched.body,
      state: fetched.state,
      url: fetched.url ?? null,
      source: "notion",
    };
  }

  invalidateFetch(canonicalId: string): void {
    invalidateFetchField(this.taskCachePath(canonicalId));
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

  private readFetchCache(canonicalId: string): NotionFetch | null {
    const cache = readTaskCache(this.taskCachePath(canonicalId));
    return cache?.fetch ?? null;
  }

  private writeFetchCache(canonicalId: string, value: NotionFetch): void {
    mergeFetch(this.taskCachePath(canonicalId), value);
  }

  private runClaude(prompt: string): string {
    let result;
    try {
      result = this.runner(
        [
          "claude",
          "--print",
          "--output-format",
          "json",
          "--model",
          claudeModel(this.env),
          "--permission-mode",
          "dontAsk",
          prompt,
        ],
        { check: false, env: this.env },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(
          `claude MCP resolver: \`claude\` binary not found on PATH. Install via home-manager (programs.claude-runtime.enable = true) or run \`prx preflight claude\`.`,
        );
      }
      throw new Error(`claude MCP resolver: failed to spawn claude: ${message}`);
    }
    const stderrSignal = detectHeadlessOAuthRequired(result.stderr);
    if (stderrSignal) {
      throw headlessOAuthError(stderrSignal);
    }
    const stdoutSignal = detectHeadlessOAuthRequired(result.stdout);
    if (stdoutSignal) {
      throw headlessOAuthError(stdoutSignal);
    }
    if (result.status !== 0) {
      throw new Error(
        `claude MCP resolver: claude exited with status ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const text = parseClaudeResult(result.stdout);
    const resultSignal = detectHeadlessOAuthRequired(text);
    if (resultSignal) {
      throw headlessOAuthError(resultSignal);
    }
    return text;
  }

  private searchForPage(canonicalId: string): NotionLookup {
    const text = this.runClaude(LOOKUP_PROMPT(canonicalId));
    const parsed = extractJsonObject(text) as {
      pageId?: unknown;
      pageUrl?: unknown;
      error?: unknown;
    };
    if (parsed.error === "not_found") {
      throw new Error(
        `claude MCP resolver: Notion search returned no page matching ${canonicalId}`,
      );
    }
    if (typeof parsed.pageId !== "string" || parsed.pageId.length === 0) {
      throw new Error(
        `claude MCP resolver: search result missing "pageId" string field. got: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    const url = typeof parsed.pageUrl === "string" ? parsed.pageUrl : null;
    // notion-search returns only pageId+pageUrl — title is not known until
    // the fetch half completes, so we cache it as null here.
    return { pageId: parsed.pageId, title: null, url };
  }

  private fetchPage(pageId: string): NotionFetch {
    const text = this.runClaude(FETCH_PROMPT(pageId));
    const parsed = extractJsonObject(text) as {
      title?: unknown;
      body?: unknown;
      state?: unknown;
      url?: unknown;
    };
    if (typeof parsed.title !== "string") {
      throw new Error(
        `claude MCP resolver: fetch result missing "title" string field. got: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    const body = typeof parsed.body === "string" ? parsed.body : null;
    const stateRaw = typeof parsed.state === "string" ? parsed.state : "unknown";
    const state: "open" | "closed" | "unknown" =
      stateRaw === "open" || stateRaw === "closed" ? stateRaw : "unknown";
    const url = typeof parsed.url === "string" ? parsed.url : null;
    return {
      title: parsed.title,
      body,
      state,
      url,
      fetchedAt: new Date().toISOString(),
    };
  }
}
