import { processEnv } from "@bounded-systems/env";
import { authToken } from "@bounded-systems/auth";

import type { NotionIdentityConfig } from "../github.ts";
import type {
  NotionPageLookup,
  NotionPageResolver,
  ResolvedWorkUnit,
} from "./types.ts";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Hyphenated or unhyphenated 32-hex Notion page UUID — short-circuits the
// database query path when scout passes a UUID directly (GH-1420).
const NOTION_PAGE_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export type NotionFetch = typeof fetch;

type NotionPage = {
  id: string;
  url?: string | undefined;
  properties?: Record<string, unknown> | undefined;
};

type NotionQueryResponse = {
  results?: Array<NotionPage>;
  message?: string;
};

type NotionPageResponse = NotionPage & {
  message?: string;
  object?: string;
};

type NotionBlockChildrenResponse = {
  results?: Array<{
    type?: string;
    paragraph?: { rich_text?: Array<{ plain_text?: string }> };
    heading_1?: { rich_text?: Array<{ plain_text?: string }> };
    heading_2?: { rich_text?: Array<{ plain_text?: string }> };
    heading_3?: { rich_text?: Array<{ plain_text?: string }> };
    bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
    numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
    to_do?: { rich_text?: Array<{ plain_text?: string }> };
    quote?: { rich_text?: Array<{ plain_text?: string }> };
    code?: { rich_text?: Array<{ plain_text?: string }> };
  }>;
  has_more?: boolean;
  next_cursor?: string | null;
  message?: string;
};

function readToken(env: NodeJS.ProcessEnv): string {
  // Credential access routes through the @bounded-systems/auth capability (authority as a
  // visible import edge); the resolver's injectable env seam is threaded in so
  // tests stay hermetic.
  const token = authToken("notion", env);
  if (!token) {
    throw new Error(
      "NOTION_TOKEN environment variable is required for the Notion resolver. " +
        "Export a Notion integration token with read access to the configured database.",
    );
  }
  return token;
}

function extractTitle(
  properties: Record<string, unknown> | undefined,
  titleProperty: string,
): string {
  const prop = properties?.[titleProperty] as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const parts = prop?.title?.map((t) => t.plain_text ?? "") ?? [];
  return parts.join("").trim();
}

function extractStatus(
  properties: Record<string, unknown> | undefined,
  statusProperty: string | null,
): "open" | "closed" | "unknown" {
  if (!statusProperty) {
    return "unknown";
  }
  const prop = properties?.[statusProperty] as
    | {
        status?: { name?: string };
        select?: { name?: string };
        type?: string;
      }
    | undefined;
  const name = prop?.status?.name ?? prop?.select?.name ?? null;
  if (!name) {
    return "unknown";
  }
  const normalized = name.toLowerCase();
  if (normalized === "done" || normalized === "closed" || normalized === "complete" || normalized === "completed") {
    return "closed";
  }
  return "open";
}

function extractBlockText(block: NonNullable<NotionBlockChildrenResponse["results"]>[number]): string | null {
  const payload =
    block.paragraph ??
    block.heading_1 ??
    block.heading_2 ??
    block.heading_3 ??
    block.bulleted_list_item ??
    block.numbered_list_item ??
    block.to_do ??
    block.quote ??
    block.code ??
    null;
  if (!payload) {
    return null;
  }
  const parts = payload.rich_text?.map((t) => t.plain_text ?? "") ?? [];
  const text = parts.join("");
  return text.length > 0 ? text : null;
}

export class NotionResolver implements NotionPageResolver {
  readonly name = "notion" as const;

  constructor(
    private readonly config: NotionIdentityConfig,
    private readonly env: NodeJS.ProcessEnv = processEnv(),
    private readonly fetchImpl: NotionFetch = fetch,
  ) {}

  async fetch(canonicalId: string): Promise<ResolvedWorkUnit> {
    if (
      !this.config.databaseId ||
      !this.config.idProperty ||
      !this.config.titleProperty
    ) {
      throw new Error(
        "NotionResolver requires database_id, id_property, and title_property (auth = \"rest\")",
      );
    }
    const token = readToken(this.env);
    const page = await this.queryPageByCanonicalId(canonicalId, token);
    const body = await this.fetchPageBody(page.id, token);
    return {
      id: canonicalId,
      title: extractTitle(page.properties, this.config.titleProperty),
      body,
      state: extractStatus(page.properties, this.config.statusProperty),
      url: page.url ?? null,
      source: "notion",
    };
  }

  // GH-1420: surface the Notion page UUID for scout. UUID inputs skip the
  // database-query round-trip; Task-ID inputs reuse the existing filter path.
  async findPageId(canonicalId: string): Promise<NotionPageLookup> {
    if (NOTION_PAGE_UUID.test(canonicalId)) {
      return { pageId: canonicalId, pageUrl: null };
    }
    if (!this.config.databaseId || !this.config.idProperty) {
      throw new Error(
        "NotionResolver requires database_id and id_property to resolve Task-IDs (auth = \"rest\")",
      );
    }
    const token = readToken(this.env);
    const page = await this.queryPageByCanonicalId(canonicalId, token);
    return { pageId: page.id, pageUrl: page.url ?? null };
  }

  // GH-1420: fetch a page by its Notion UUID via the page-retrieve API,
  // bypassing the canonical-id database filter.
  async fetchByPageId(pageId: string): Promise<ResolvedWorkUnit> {
    if (!this.config.titleProperty) {
      throw new Error(
        "NotionResolver requires title_property to render fetched pages (auth = \"rest\")",
      );
    }
    const token = readToken(this.env);
    const page = await this.retrievePage(pageId, token);
    const body = await this.fetchPageBody(pageId, token);
    return {
      id: pageId,
      title: extractTitle(page.properties, this.config.titleProperty),
      body,
      state: extractStatus(page.properties, this.config.statusProperty),
      url: page.url ?? null,
      source: "notion",
    };
  }

  private async queryPageByCanonicalId(
    canonicalId: string,
    token: string,
  ): Promise<NonNullable<NotionQueryResponse["results"]>[number]> {
    const url = `${NOTION_API_BASE}/databases/${this.config.databaseId!}/query`;
    const body = JSON.stringify({
      filter: {
        property: this.config.idProperty!,
        rich_text: { equals: canonicalId },
      },
      page_size: 2,
    });
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(token),
      body,
    });
    const payload = (await res.json()) as NotionQueryResponse;
    if (!res.ok) {
      throw new Error(
        `Notion query failed (${res.status}): ${payload.message ?? res.statusText}`,
      );
    }
    const results = payload.results ?? [];
    if (results.length === 0) {
      throw new Error(
        `Notion database ${this.config.databaseId} has no page matching ${this.config.idProperty} == ${canonicalId}`,
      );
    }
    if (results.length > 1) {
      throw new Error(
        `Notion database ${this.config.databaseId} has multiple pages matching ${this.config.idProperty} == ${canonicalId} (ambiguous)`,
      );
    }
    return results[0]!;
  }

  private async retrievePage(pageId: string, token: string): Promise<NotionPage> {
    const url = `${NOTION_API_BASE}/pages/${pageId}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(token),
    });
    const payload = (await res.json()) as NotionPageResponse;
    if (!res.ok) {
      throw new Error(
        `Notion page retrieve failed (${res.status}): ${payload.message ?? res.statusText}`,
      );
    }
    return {
      id: payload.id ?? pageId,
      url: payload.url,
      properties: payload.properties,
    };
  }

  private async fetchPageBody(pageId: string, token: string): Promise<string | null> {
    const lines: string[] = [];
    let cursor: string | null = null;
    do {
      const cursorParam = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
      const url = `${NOTION_API_BASE}/blocks/${pageId}/children?page_size=100${cursorParam}`;
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers(token),
      });
      const payload = (await res.json()) as NotionBlockChildrenResponse;
      if (!res.ok) {
        throw new Error(
          `Notion block fetch failed (${res.status}): ${payload.message ?? res.statusText}`,
        );
      }
      for (const block of payload.results ?? []) {
        const text = extractBlockText(block);
        if (text !== null) {
          lines.push(text);
        }
      }
      cursor = payload.has_more ? payload.next_cursor ?? null : null;
    } while (cursor);
    if (lines.length === 0) {
      return null;
    }
    return lines.join("\n\n");
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };
  }
}
