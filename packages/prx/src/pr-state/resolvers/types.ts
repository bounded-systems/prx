import type { CommandRunner } from "../github.ts";

export type WorkUnitSource = "github" | "notion" | "beads";

export const workUnitSources: readonly WorkUnitSource[] = ["github", "notion", "beads"];

export type ResolvedWorkUnit = {
  id: string;
  title: string;
  body: string | null;
  state: "open" | "closed" | "unknown";
  url: string | null;
  source: WorkUnitSource;
};

export interface WorkUnitResolver {
  readonly name: WorkUnitSource;
  fetch(canonicalId: string, opts?: { runner?: CommandRunner }): Promise<ResolvedWorkUnit>;
}

// GH-1420: scout-side sibling. The Notion-backed resolvers (claude-mcp + REST)
// expose a page-UUID seam so `prx scout notion <id>` can report the canonical
// Notion page id alongside the resolved body, regardless of whether the input
// was a raw UUID or a Task-ID. Implementations short-circuit UUID inputs to
// avoid an unneeded notion-search round-trip.
export type NotionPageLookup = {
  pageId: string;
  pageUrl: string | null;
};

export interface NotionPageResolver extends WorkUnitResolver {
  findPageId(canonicalId: string): Promise<NotionPageLookup>;
  fetchByPageId(pageId: string): Promise<ResolvedWorkUnit>;
}
