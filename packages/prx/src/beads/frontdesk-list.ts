// The Front Desk `list` source (GH-1011 — retire `bd list`, sub-issue of
// GH-1008 "retire beads").
//
// `bd list --all` was prx's aggregate work-item read (the BeadsCache-fed fleet:
// next-work enrichment, resolvers, plan/intake search). This serves that read
// from Front Desk instead — the GH-canonical mirror, off the GitHub API — by
// spawning `fds list` and shaping each item into the RAW `bd list --json` object
// the existing `parseBeadsRecords` transform already consumes. So the whole
// fleet keeps its `BeadsRecord` shape; only the substrate changes.
//
// Both aggregate loaders (`loadAllBeadsViaDaemon`, and `loadAllBeadsViaCli` via
// the `prx beads list` spawn) funnel through the daemon `{kind:"list"}` case, so
// intercepting there — plus `{kind:"show"}` for the targeted read — flips the
// fleet in one place (mirroring the `ready` door, GH-1010).
//
// Identity: Front Desk is GH-canonical, so a work item becomes `id = GH-<n>`
// with `external_ref` = the issue URL (parseBeadsRecord derives externalRefs.gh
// + externalIssueNumber from it). `PRX_LIST_SOURCE=bd` is the escape hatch.
// Degraded vs bd: description/priority/notes/assignee/timestamps aren't on the
// mirror — parseBeadsRecord defaults them (the consumers that needed them are
// the bd-sync/maintenance tools retired in GH-1012, not the read fleet).

import { processEnv } from "@bounded-systems/env";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { resolveRepoName } from "./frontdesk-source.ts";

export type ListSource = "frontdesk" | "bd";

/** Resolve the list source: explicit opt → PRX_LIST_SOURCE → "frontdesk". */
export function resolveListSource(explicit?: ListSource): ListSource {
  if (explicit) return explicit;
  return processEnv().PRX_LIST_SOURCE === "bd" ? "bd" : "frontdesk";
}

// What `fds list --json` (FDS_JSON=1) emits.
interface FdsListRef {
  number: number;
  repository: string;
}
interface FdsListItem {
  number: number;
  repository: string;
  kind: string;
  title: string;
  status: string;
  effort: number;
  value: number;
  dependsOn: number[];
  ageDays: number;
}
interface FdsListOutput {
  source: string;
  syncedAt: string | null;
  items: FdsListItem[];
  edges: { from: FdsListRef; to: FdsListRef; kind: string }[];
}

export type FrontDeskListDeps = {
  run?: CommandRunner | undefined;
  bin?: string | undefined;
  env?: (() => Record<string, string>) | undefined;
};

const DEFAULT_FRONTDESK_BIN = "fds";

/** Front Desk status → bd status vocabulary. */
function toBdStatus(status: string): string {
  switch (status) {
    case "Todo":
      return "open";
    case "In Progress":
    case "In Review":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "closed";
    default:
      return "open";
  }
}

function issueUrl(repository: string, number: number): string {
  return `https://github.com/bounded-systems/${repository}/issues/${number}`;
}

/**
 * Fetch the Front Desk work-item list and shape it as a RAW `bd list --json`
 * array (snake_case) — the input `parseBeadsRecords` expects. Each item's
 * outgoing dep edges become `dependencies[]` ({issue_id, depends_on_id, type}).
 * Throws on an fds failure (escape hatch: `PRX_LIST_SOURCE=bd`), named in the error.
 */
export function frontDeskBeadsRaw(cwd: string, deps: FrontDeskListDeps = {}): unknown[] {
  const run = deps.run ?? procRunner;
  const readEnv = deps.env ?? processEnv;
  const e = readEnv();
  const bin = deps.bin ?? e.PRX_FRONTDESK_BIN ?? DEFAULT_FRONTDESK_BIN;
  const repo = resolveRepoName(cwd, run);

  const args = ["list", ...(repo ? ["--repo", repo] : [])];
  const r = run([bin, ...args], { check: false, env: { ...e, FDS_JSON: "1" } });
  if (r.status !== 0) {
    throw new Error(
      `fds list failed (exit ${r.status}): ${r.stderr.trim()} ` +
        `— set PRX_LIST_SOURCE=bd to fall back to \`bd list\`.`,
    );
  }

  const parsed = JSON.parse(r.stdout.trim()) as FdsListOutput;
  // Pre-index outgoing edges by source number.
  const depsByNumber = new Map<
    number,
    { issue_id: string; depends_on_id: string; type: string }[]
  >();
  for (const edge of parsed.edges) {
    const list = depsByNumber.get(edge.from.number) ?? [];
    list.push({
      issue_id: `GH-${edge.from.number}`,
      depends_on_id: `GH-${edge.to.number}`,
      type: edge.kind,
    });
    depsByNumber.set(edge.from.number, list);
  }

  return parsed.items.map((it) => ({
    id: `GH-${it.number}`,
    title: it.title,
    status: toBdStatus(it.status),
    issue_type: it.kind,
    external_ref: issueUrl(it.repository, it.number),
    source_system: `github:${it.number}`,
    dependencies: depsByNumber.get(it.number) ?? [],
  }));
}

/** One raw record by synthetic id (`GH-<n>`) — the `bd show <id>` replacement. */
export function frontDeskBeadRaw(
  cwd: string,
  id: string,
  deps: FrontDeskListDeps = {},
): unknown | null {
  const rows = frontDeskBeadsRaw(cwd, deps) as { id: string }[];
  return rows.find((r) => r.id === id) ?? null;
}
