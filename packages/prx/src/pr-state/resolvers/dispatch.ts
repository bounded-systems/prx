import { beadsDomainAdapter } from "../../adapters/beads.ts";
import type { IdentityConfig, SourceConfig } from "../github.ts";
import { BeadsResolver } from "./beads.ts";
import { GithubResolver } from "./github.ts";
import { NotionResolver } from "./notion.ts";
import { NotionClaudeMcpResolver } from "./notion_claude_mcp.ts";
import { NotionCliResolver } from "./notion_cli.ts";
import type { WorkUnitResolver } from "./types.ts";

const GH_ID_PATTERN = /^GH-\d+$/;

export type ResolverDispatchOpts = {
  // GH-1421: when present, force dispatch through the named registry entry.
  // Pattern mismatch becomes a null return (caller renders "available sources: …").
  source?: string;
};

function resolverForSource(src: SourceConfig, repoPath: string): WorkUnitResolver {
  switch (src.kind) {
    case "github":
      return new GithubResolver(repoPath);
    case "beads":
      // GH-852: thread the source's external_ref_prefix into the resolver so
      // the non-BD canonical-id arm (e.g. PROJ-5743) can map onto the
      // operator-tagged bd row via externalRefs[<prefix>].
      return new BeadsResolver(repoPath, { externalRefPrefix: src.externalRefPrefix ?? null });
    case "notion":
      if (src.notion.auth === "notion-cli") return new NotionCliResolver(src.notion, repoPath);
      if (src.notion.auth === "claude-mcp")
        return new NotionClaudeMcpResolver(src.notion, repoPath);
      return new NotionResolver(src.notion);
  }
}

export function resolverForCanonicalId(
  id: string,
  config: IdentityConfig,
  repoPath: string,
  opts?: ResolverDispatchOpts,
): WorkUnitResolver | null {
  // GH-1421: explicit `--source=<name>` wins. Pattern-mismatch is a null
  // return (the caller formats the error with the available source names).
  if (opts?.source !== undefined) {
    const src = config.sources[opts.source];
    if (!src) return null;
    if (!src.canonicalIdPattern.test(id)) return null;
    return resolverForSource(src, repoPath);
  }

  // Legacy fast path — GH-<n> always routes to the GitHub resolver. Kept
  // ahead of the registry walk so a non-default overlay that registers
  // `[sources.notion]` with a wider pattern (e.g. /^(GH|PROJ)-\d+$/)
  // still routes `GH-123` to the GitHub resolver, matching pre-GH-1421
  // dispatch semantics.
  if (GH_ID_PATTERN.test(id)) {
    return new GithubResolver(repoPath);
  }

  // GH-1766: bd surface id arm. The BdDomainAdapter recognises both `BD-`-
  // prefixed shapes and (against the cwd repo's `bd_workspace_prefix`) the
  // bare workspace-long-id form. Routed before the registry walk so a bd id
  // never falls through to a Notion resolver configured on the same repo.
  if (beadsDomainAdapter.matchesSurfaceId(id)) {
    return new BeadsResolver(repoPath);
  }

  // GH-1421: first registry entry whose pattern matches the id wins.
  for (const src of Object.values(config.sources)) {
    if (src.kind === "github") continue; // already handled by the GH fast path
    if (src.canonicalIdPattern.test(id)) {
      return resolverForSource(src, repoPath);
    }
  }
  return null;
}
