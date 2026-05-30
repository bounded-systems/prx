/**
 * Adapter registry barrel. Importing this module side-effect-registers every
 * built-in `DomainAdapter` on the registry so callers get a fully-populated
 * dispatch surface (`adapterForCanonicalId`, `adapterForDomain`,
 * `combinedCanonicalIdPattern`) with a single import. Add new adapters here
 * — production importers should reach for the barrel rather than the
 * per-domain module so registration stays centralised.
 */

// Side-effect: every adapter module self-registers on import.
import "./github.ts";
import "./notion.ts";
import "./beads.ts";

// Re-exports for callers that want the singleton (or the adapter class)
// directly.
export {
  GH_OWNED_ON_PULL,
  GhDomainAdapter,
  GhDomainAdapterError,
  githubDomainAdapter,
  type GhDomainAdapterDeps,
} from "./github.ts";
export {
  NOTION_OWNED_ON_PULL,
  NotionDomainAdapter,
  NotionDomainAdapterError,
  notionDomainAdapter,
  type NotionDomainAdapterDeps,
} from "./notion.ts";
export {
  BD_OWNED_ON_PULL,
  BD_SHORT_ID_PATTERN,
  BdDomainAdapter,
  BdDomainAdapterError,
  beadsDomainAdapter,
  type BdDomainAdapterDeps,
} from "./beads.ts";

// Re-export the interface + registry seams so consumers don't have to
// dual-import from `./domain-adapter.ts` + `./adapters`.
export * from "./domain-adapter.ts";
