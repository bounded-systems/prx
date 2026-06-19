// GH-1420 — `scout notion <id>`: resolve a Notion page UUID or configured
// Task-ID (e.g. `PROJ-NNNN`) to a structured single-record envelope.
// Sibling of `scout/files.ts` and `scout/read.ts`; emits one JSON envelope
// so the dispatch envelope captures a single CAS record per invocation.
//
// The verb is read-only: it never writes to Notion, GH, or beads. Reverse
// mirrors (gh_issue, bd_id) are populated when found via `gh issue list
// --search` body match + bd external-ref index, otherwise null.

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  type CommandRunner,
  defaultRunner,
  effectiveCanonicalIdPattern,
  findFirstSourceOfKind,
  type IdentityConfig,
  loadIdentityConfig,
  type NotionIdentityConfig,
} from "../pr-state/github.ts";
import { NotionResolver } from "../pr-state/resolvers/notion.ts";
import { NotionClaudeMcpResolver } from "../pr-state/resolvers/notion_claude_mcp.ts";
import type {
  NotionPageLookup,
  NotionPageResolver,
  ResolvedWorkUnit,
} from "../pr-state/resolvers/types.ts";
import { searchGh } from "../issues/search.ts";
import { indexBeadsByIssueNumber, loadAllBeads as defaultLoadAllBeads } from "../triage/triage.ts";
import type { execBd } from "@bounded-systems/bd";
import type { execGh } from "@bounded-systems/gh";

// Notion page UUID shape — accepts hyphenated and unhyphenated 32-hex.
// Exported so the shared issue resolver (src/issues/resolver.ts, GH-874) can
// reuse the same shape check without duplicating the regex.
export const NOTION_UUID_RE =
  /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

// Generic Task-ID shape (`PROJ-5779`, `OPS-42`, …). The configured
// canonical_id_pattern is checked separately when present. Exported for the
// shared resolver (GH-874).
export const TASK_ID_SHAPE_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export type DetectedNotionId = { kind: "uuid"; value: string } | { kind: "task_id"; value: string };

export const scoutNotionResultSchema = z
  .object({
    uuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    task_id: z.string().nullable(),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    state: z.enum(["open", "closed", "unknown"]),
    gh_issue: z.number().int().positive().nullable(),
    bd_id: z.string().nullable(),
    intake_shape: z.object({
      type: z.string().nullable(),
      title: z.string(),
      body: z.string().nullable(),
    }),
  })
  .strict();

export type ScoutNotionResult = z.infer<typeof scoutNotionResultSchema>;

export type NotionResolverFactory = (args: {
  config: NotionIdentityConfig;
  repoPath: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}) => NotionPageResolver;

export interface ScoutNotionInput {
  /** Notion page UUID or configured Task-ID. */
  id: string;
  /** Working directory for resolving prx.toml. Defaults to process.cwd(). */
  cwd?: string | undefined;
  /** Skip GH/bd reverse-mirror lookup. */
  noMirrors?: boolean | undefined;
  /** DI seam — config loader. */
  loadIdentity?: typeof loadIdentityConfig | undefined;
  /** DI seam — CommandRunner used by the claude-mcp resolver path. */
  runner?: CommandRunner | undefined;
  /** DI seam — fetch impl used by the REST resolver path. */
  fetchImpl?: typeof fetch | undefined;
  /** DI seam — process env. Defaults to processEnv(). */
  env?: NodeJS.ProcessEnv | undefined;
  /** DI seam — full resolver override (tests). */
  resolverFactory?: NotionResolverFactory | undefined;
  /** DI seam — gh wrapper for reverse-mirror lookup. */
  ghExec?: typeof execGh | undefined;
  /** DI seam — bd wrapper for reverse-mirror lookup. */
  bdExec?: typeof execBd | undefined;
  /** DI seam — bd loader (composes with bdExec). */
  loadAllBeads?: typeof defaultLoadAllBeads;
}

export class ScoutNotionError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ScoutNotionError";
    this.code = code;
  }
}

export function detectNotionId(input: string, canonicalIdPattern?: RegExp): DetectedNotionId {
  if (typeof input !== "string" || input.length === 0) {
    throw new ScoutNotionError("id must not be empty", "MISSING_ID");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ScoutNotionError("id must not be empty", "MISSING_ID");
  }
  const m = trimmed.match(NOTION_UUID_RE);
  if (m) {
    const [, a, b, c, d, e] = m;
    return { kind: "uuid", value: `${a}-${b}-${c}-${d}-${e}`.toLowerCase() };
  }
  if (TASK_ID_SHAPE_RE.test(trimmed)) {
    if (canonicalIdPattern && !canonicalIdPattern.test(trimmed)) {
      throw new ScoutNotionError(
        `id ${trimmed} does not match the configured canonical_id_pattern`,
        "INVALID_ID",
      );
    }
    return { kind: "task_id", value: trimmed };
  }
  throw new ScoutNotionError(
    `id ${input} is neither a Notion page UUID nor a configured Task-ID`,
    "INVALID_ID",
  );
}

const defaultResolverFactory: NotionResolverFactory = ({
  config,
  repoPath,
  runner,
  env,
  fetchImpl,
}) => {
  if (config.auth === "claude-mcp") {
    return new NotionClaudeMcpResolver(config, repoPath, runner, env);
  }
  if (config.auth === "rest") {
    return new NotionResolver(config, env, fetchImpl);
  }
  throw new ScoutNotionError(
    `scout notion: auth = "${config.auth}" is not supported (use "rest" or "claude-mcp")`,
    "NOTION_NOT_CONFIGURED",
  );
};

export async function runScoutNotion(input: ScoutNotionInput): Promise<ScoutNotionResult> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? processEnv();
  const runner = input.runner ?? defaultRunner;
  const loadIdentity = input.loadIdentity ?? loadIdentityConfig;
  const fetchImpl = input.fetchImpl ?? fetch;
  const factory = input.resolverFactory ?? defaultResolverFactory;
  const loadAllBeadsImpl = input.loadAllBeads ?? defaultLoadAllBeads;

  let config: IdentityConfig;
  try {
    config = loadIdentity(cwd, runner);
  } catch (err) {
    throw wrap(err, "NOTION_NOT_CONFIGURED", "identity config load failed");
  }
  const notionSource = findFirstSourceOfKind(config, "notion");
  if (!notionSource) {
    throw new ScoutNotionError(
      'scout notion: prx.toml has no [sources.<name>] block with kind = "notion" (configure auth = "rest" or "claude-mcp")',
      "NOTION_NOT_CONFIGURED",
    );
  }

  const detected = detectNotionId(input.id, effectiveCanonicalIdPattern(config));

  const resolver = factory({
    config: notionSource.notion,
    repoPath: cwd,
    runner,
    env,
    fetchImpl,
  });

  let lookup: NotionPageLookup;
  try {
    lookup = await resolver.findPageId(detected.value);
  } catch (err) {
    throw wrap(err, "NOTION_LOOKUP_FAILED", "Notion lookup failed");
  }
  const normalizedUuid = normalizeUuid(lookup.pageId);
  if (!normalizedUuid) {
    throw new ScoutNotionError(
      `Notion lookup returned a non-UUID pageId: ${lookup.pageId}`,
      "NOTION_LOOKUP_FAILED",
    );
  }

  let resolved: ResolvedWorkUnit;
  try {
    resolved = await resolver.fetchByPageId(normalizedUuid);
  } catch (err) {
    throw wrap(err, "NOTION_FETCH_FAILED", "Notion fetch failed");
  }

  const taskId = detected.kind === "task_id" ? detected.value : null;
  const url = resolved.url ?? lookup.pageUrl ?? null;

  let ghIssue: number | null = null;
  let bdId: string | null = null;
  if (!input.noMirrors) {
    if (input.ghExec) {
      try {
        const hits = searchGh(normalizedUuid, "all", input.ghExec, "scout notion", 5);
        for (const hit of hits) {
          const num = Number.parseInt(hit.id.replace(/^GH-/, ""), 10);
          if (Number.isFinite(num) && num > 0) {
            ghIssue = num;
            break;
          }
        }
      } catch (err) {
        throw wrap(err, "MIRROR_LOOKUP_FAILED", "GH mirror lookup failed");
      }
    }
    if (ghIssue !== null && input.bdExec) {
      try {
        const records = loadAllBeadsImpl(input.bdExec);
        const map = indexBeadsByIssueNumber(records);
        const record = map.get(ghIssue);
        if (record) bdId = record.id;
      } catch (err) {
        throw wrap(err, "MIRROR_LOOKUP_FAILED", "bd mirror lookup failed");
      }
    }
  }

  return scoutNotionResultSchema.parse({
    uuid: normalizedUuid,
    task_id: taskId,
    title: resolved.title,
    body: resolved.body,
    url,
    state: resolved.state,
    gh_issue: ghIssue,
    bd_id: bdId,
    intake_shape: {
      type: null,
      title: resolved.title,
      body: resolved.body,
    },
  });
}

function normalizeUuid(value: string): string | null {
  const m = value.match(NOTION_UUID_RE);
  if (!m) return null;
  const [, a, b, c, d, e] = m;
  return `${a}-${b}-${c}-${d}-${e}`.toLowerCase();
}

function wrap(err: unknown, code: string, prefix: string): ScoutNotionError {
  if (err instanceof ScoutNotionError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ScoutNotionError(`${prefix}: ${msg}`, code);
}

/**
 * Render a result as a single-line JSON envelope. Dispatch writes this stdout
 * into CAS verbatim so the resulting `scout://sha256:…` handle holds the full
 * notion record.
 */
export function formatScoutNotionJson(result: ScoutNotionResult): string {
  return JSON.stringify(result) + "\n";
}
