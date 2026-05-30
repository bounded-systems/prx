/**
 * Notion domain adapter (GH-1614) — the second `DomainAdapter` implementation
 * (sibling to `src/adapters/github.ts`). Per the GH-1500 authority ADR: beads
 * is canonical for every UoW; external DBs are pluggable mirror targets,
 * opt-in per UoW. This adapter plugs Notion into the GH-1536 seam so the
 * `prx beads sync --domain notion` path has something to dispatch through.
 *
 * Field ownership (`ownedOnPull`) is the ADR §2 Notion column. `status` is
 * the only `ResolvedWorkUnitPatch` slot Notion meaningfully owns today:
 * `externalIssueNumber` is GitHub-specific (no Notion analogue), and Notion
 * has no native `assignees` / `milestone` mapping. bd is authoritative for
 * title / body / type / priority / area / effort / labels per the ADR.
 *
 *   - `pull(externalId)` — dispatches by `identity.notion.auth` across the
 *                          existing three resolvers (`rest` / `claude-mcp` /
 *                          `notion-cli`) and maps the resolved `state` to a
 *                          `ResolvedWorkUnitPatch.status` (`"open"|"closed"|"unknown"`).
 *   - `push(bd)`        — REST only. Linked: PATCH the page's title property.
 *                          Unlinked: POST a new page into the configured
 *                          database, then `bd update --metadata
 *                          external_refs.notion=<uuid>` writes the page UUID
 *                          back. Body is only written on the unlinked create
 *                          path; body PATCH on linked is deferred — title-only
 *                          mirrors what `pushActor` is responsible for today.
 *   - `resolve(id)`     — external id (page UUID) → bd short-id via
 *                          `buildBeadsLookup(beads).byDomainExternalId.get("notion")`.
 *   - `bulkClose({ids})` — loops `bd update <id> --status closed` per
 *                          provided bead id. Notion has no repo-wide
 *                          `bd notion sync` analog of GitHub's bulk verb, so
 *                          each pair closes itself via the per-id update path.
 */

import { processEnv } from "@bounded-systems/env";
import { buildBeadsLookup } from "../issues/dedupe.ts";
import {
  defaultRunner,
  findFirstSourceOfKind,
  loadIdentityConfig as defaultLoadIdentityConfig,
  type IdentityConfig,
  type NotionIdentityConfig,
} from "../pr-state/github.ts";
import { NotionResolver } from "../pr-state/resolvers/notion.ts";
import { NotionClaudeMcpResolver } from "../pr-state/resolvers/notion_claude_mcp.ts";
import { NotionCliResolver } from "../pr-state/resolvers/notion_cli.ts";
import type {
  NotionPageResolver,
  WorkUnitResolver,
  ResolvedWorkUnit,
} from "../pr-state/resolvers/types.ts";
import {
  execBd as defaultExecBd,
  type BdExecResult,
} from "@bounded-systems/bd";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import {
  NOTION_SURFACE_ID_PATTERN,
  registerDomainAdapter,
  type AdapterIoOpts,
  type DomainAdapter,
  type DomainAdapterConfig,
  type DomainPushFields,
  type DomainPushResult,
  type EnumerateRange,
  type ExternalRecordRef,
  type ResolvedWorkUnitPatch,
} from "./domain-adapter.ts";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";

// Hyphenated or unhyphenated 32-hex Notion page UUID. Mirrors the regex in
// `src/pr-state/resolvers/notion.ts:13`; that one is module-private. The shape
// is the same: 8-4-4-4-12 hex with optional dashes.
const NOTION_PAGE_UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const NOTION_SURFACE_ID_RE = /^NOTION-([0-9a-fA-F]{32}|\d+)$/;

export class NotionDomainAdapterError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "NotionDomainAdapterError";
    this.exitCode = exitCode;
  }
}

export type NotionDomainAdapterDeps = {
  /** REST seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** bd CLI exec. Defaults to `execBd`. */
  execBd?: typeof defaultExecBd;
  /** Loader for the full bd record set. Defaults to `loadAllBeads`. */
  loadAllBeads?: typeof defaultLoadAllBeads;
  /** `prx.toml` identity loader. Defaults to `loadIdentityConfig`. */
  loadIdentityConfig?: typeof defaultLoadIdentityConfig;
  /** Env vars (`NOTION_TOKEN`). Defaults to `processEnv()`. */
  env?: NodeJS.ProcessEnv;
  /** cwd source. Defaults to `process.cwd`. */
  cwd?: () => string;
  /** REST resolver factory — defaults to `new NotionResolver(...)`. */
  createRestResolver?: (
    cfg: NotionIdentityConfig,
    env: NodeJS.ProcessEnv,
    fetchImpl: typeof fetch,
  ) => NotionPageResolver;
  /** Claude-MCP resolver factory — defaults to `new NotionClaudeMcpResolver(...)`. */
  createClaudeMcpResolver?: (
    cfg: NotionIdentityConfig,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => NotionPageResolver;
  /** notion-cli resolver factory — defaults to `new NotionCliResolver(...)`. */
  createCliResolver?: (cfg: NotionIdentityConfig, cwd: string) => WorkUnitResolver;
};

// ADR §2 Notion column. `ResolvedWorkUnitPatch` only carries
// `externalIssueNumber | status | assignees | milestone`; for Notion only
// `status` has a sensible projection. Editing this list MUST be accompanied by
// an edit to docs/spikes/GH-1500-authority.md §2 — the test suite asserts
// byte-equality.
export const NOTION_OWNED_ON_PULL = ["status"] as const;

export class NotionDomainAdapter implements DomainAdapter {
  readonly config: DomainAdapterConfig;

  private readonly deps: Required<Pick<NotionDomainAdapterDeps, "cwd">> &
    NotionDomainAdapterDeps;

  constructor(deps: NotionDomainAdapterDeps = {}) {
    this.config = {
      domain: "notion",
      surfaceIdPattern: NOTION_SURFACE_ID_PATTERN,
      externalIdShape: "page-uuid",
      ownedOnPull: NOTION_OWNED_ON_PULL,
    };
    this.deps = { ...deps, cwd: deps.cwd ?? (() => process.cwd()) };
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? processEnv();
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private get bdExec(): typeof defaultExecBd {
    return this.deps.execBd ?? defaultExecBd;
  }

  private loadIdentity(cwd: string): IdentityConfig {
    const loader = this.deps.loadIdentityConfig ?? defaultLoadIdentityConfig;
    return loader(cwd, defaultRunner);
  }

  private notionIdentityOrThrow(cwd: string): NotionIdentityConfig {
    const identity = this.loadIdentity(cwd);
    const src = findFirstSourceOfKind(identity, "notion");
    if (!src) {
      throw new NotionDomainAdapterError(
        "notion adapter: prx.toml has no [sources.<name>] block with kind = \"notion\"; configure one to use the notion domain",
      );
    }
    return src.notion;
  }

  private loadBeads(): BeadsRecord[] {
    return (this.deps.loadAllBeads ?? defaultLoadAllBeads)(this.deps.execBd);
  }

  private buildResolver(cfg: NotionIdentityConfig, cwd: string): NotionPageResolver | WorkUnitResolver {
    if (cfg.auth === "rest") {
      const factory = this.deps.createRestResolver ?? ((c, e, f) => new NotionResolver(c, e, f));
      return factory(cfg, this.env, this.fetchImpl);
    }
    if (cfg.auth === "claude-mcp") {
      const factory =
        this.deps.createClaudeMcpResolver ??
        ((c, root, e) => new NotionClaudeMcpResolver(c, root, defaultRunner, e));
      return factory(cfg, cwd, this.env);
    }
    const factory =
      this.deps.createCliResolver ?? ((c, root) => new NotionCliResolver(c, root, defaultRunner));
    return factory(cfg, cwd);
  }

  matchesSurfaceId(id: string): boolean {
    return NOTION_SURFACE_ID_PATTERN.test(id.trim());
  }

  recognizesExternalId(externalId: string): boolean {
    if (typeof externalId !== "string") return false;
    return NOTION_PAGE_UUID_RE.test(externalId.trim());
  }

  surfaceIdToExternalId(id: string, _repoCtx?: { repo?: string; cwd?: string }): string {
    const match = id.trim().match(NOTION_SURFACE_ID_RE);
    if (!match) {
      throw new NotionDomainAdapterError(`notion adapter: not a NOTION-<id> surface id: ${id}`);
    }
    return match[1]!;
  }

  async pull(externalId: string, opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
    const cwd = opts?.cwd ?? this.deps.cwd();
    const cfg = this.notionIdentityOrThrow(cwd);
    const resolver = this.buildResolver(cfg, cwd);
    const trimmed = externalId.trim();
    let resolved: ResolvedWorkUnit;
    if (hasFetchByPageId(resolver)) {
      // `rest` and `claude-mcp` resolvers both expose the UUID seam — the
      // external id this adapter exchanges is always a page UUID.
      resolved = await resolver.fetchByPageId(trimmed);
    } else {
      // `notion-cli` only implements `WorkUnitResolver.fetch(canonicalId)`,
      // which runs `notion-cli search <id>`. The search-by-uuid path is
      // best-effort — degrade rather than refuse.
      resolved = await resolver.fetch(trimmed);
    }
    const status: "open" | "closed" | "unknown" =
      resolved.state === "open" || resolved.state === "closed" ? resolved.state : "unknown";
    return { status };
  }

  async push(
    bd: BeadsRecord,
    fields: DomainPushFields,
    opts?: AdapterIoOpts,
  ): Promise<DomainPushResult> {
    const cwd = opts?.cwd ?? this.deps.cwd();
    const cfg = this.notionIdentityOrThrow(cwd);
    if (cfg.auth !== "rest") {
      throw new NotionDomainAdapterError(
        `notion adapter push: auth = "${cfg.auth}" is read-only; switch [sources.<name>] auth to "rest" to enable push`,
      );
    }
    const token = (this.env.NOTION_TOKEN ?? "").trim();
    if (!token) {
      throw new NotionDomainAdapterError(
        "notion adapter push: NOTION_TOKEN is not set; export a Notion integration token with write access",
      );
    }
    if (!cfg.databaseId || !cfg.idProperty || !cfg.titleProperty) {
      throw new NotionDomainAdapterError(
        'notion adapter push: prx.toml [sources.<name>] (kind = "notion") requires database_id / id_property / title_property when auth = "rest"',
      );
    }

    const linked = (bd.externalRefs?.notion ?? "").trim();
    if (linked.length > 0) {
      return this.pushLinked(bd, fields, linked, cfg, token);
    }
    return this.pushUnlinked(bd, fields, cfg, token);
  }

  private async pushLinked(
    _bd: BeadsRecord,
    fields: DomainPushFields,
    pageId: string,
    cfg: NotionIdentityConfig,
    token: string,
  ): Promise<DomainPushResult> {
    const properties: Record<string, unknown> = {};
    let touched = false;
    if (typeof fields.title === "string") {
      properties[cfg.titleProperty!] = {
        title: [{ type: "text", text: { content: fields.title } }],
      };
      touched = true;
    }
    if (typeof fields.body === "string" && fields.body.length > 0) {
      // Notion body edits require PATCH /v1/blocks/<page>/children (append) or
      // a full reconciliation of existing blocks — out of scope for the first
      // cut. Surface as a typed warning so callers know to expect title-only.
      console.warn(
        "notion adapter push: body PATCH on linked pages is not yet supported; skipping body, writing title only",
      );
    }
    if (!touched) {
      return { externalId: pageId, created: false, edited: false };
    }
    const res = await this.fetchImpl(`${NOTION_API_BASE}/pages/${pageId}`, {
      method: "PATCH",
      headers: this.headers(token),
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const detail = await readJsonMessage(res);
      throw new NotionDomainAdapterError(
        `notion adapter push: PATCH /pages/${pageId} failed (${res.status}): ${detail}`,
        res.status || 1,
      );
    }
    return { externalId: pageId, created: false, edited: true };
  }

  private async pushUnlinked(
    bd: BeadsRecord,
    fields: DomainPushFields,
    cfg: NotionIdentityConfig,
    token: string,
  ): Promise<DomainPushResult> {
    const titleText = typeof fields.title === "string" ? fields.title : bd.title;
    const bodyText = typeof fields.body === "string" ? fields.body : bd.description;
    const records = this.loadBeads();
    const titleDuplicate = records.find(
      (r) =>
        r.id !== bd.id
        && typeof r.externalRefs?.notion === "string"
        && r.externalRefs.notion.length > 0
        && r.title === titleText,
    );
    if (titleDuplicate) {
      throw new NotionDomainAdapterError(
        `notion adapter push: refusing to create a duplicate Notion page — bd ${titleDuplicate.id} ` +
          `is already mirrored to ${titleDuplicate.externalRefs.notion} with the same title; ` +
          `resolve the duplicate first`,
      );
    }
    const properties: Record<string, unknown> = {
      [cfg.idProperty!]: {
        rich_text: [{ type: "text", text: { content: bd.id } }],
      },
      [cfg.titleProperty!]: {
        title: [{ type: "text", text: { content: titleText } }],
      },
    };
    const body: Record<string, unknown> = {
      parent: { database_id: cfg.databaseId! },
      properties,
    };
    if (typeof bodyText === "string" && bodyText.length > 0) {
      body.children = paragraphChildrenFromText(bodyText);
    }
    const res = await this.fetchImpl(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await readJsonMessage(res);
      throw new NotionDomainAdapterError(
        `notion adapter push: POST /pages failed (${res.status}): ${detail}`,
        res.status || 1,
      );
    }
    const payload = (await res.json()) as { id?: unknown };
    const pageId = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!pageId) {
      throw new NotionDomainAdapterError(
        "notion adapter push: POST /pages response did not include an id",
      );
    }
    const update: BdExecResult = this.bdExec(
      {
        subcommand: "update",
        args: [bd.id, "--metadata", `external_refs.notion=${pageId}`],
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    if (update.exitCode !== 0) {
      const detail = update.stderr.trim() || update.stdout.trim() || "bd update failed";
      throw new NotionDomainAdapterError(
        `notion adapter push: created ${pageId} but bd write-back failed: ${detail}`,
        update.exitCode || 1,
      );
    }
    return { externalId: pageId, created: true, edited: true };
  }

  /**
   * GH-1469 — not implemented for Notion. `prx sync backfill` is GitHub-only
   * in the first cut (the cursor-skip incident it heals is a GitHub sync
   * artifact); Notion has no issue-number range to enumerate. Throws a typed
   * error so the interface stays total while non-gh backfill remains out of
   * scope.
   */
  async enumerate(
    _range: EnumerateRange,
    _opts?: AdapterIoOpts,
  ): Promise<ExternalRecordRef[]> {
    throw new NotionDomainAdapterError(
      "notion adapter: enumerate (prx sync backfill) is not implemented for the notion domain",
    );
  }

  async resolve(externalId: string, _opts?: AdapterIoOpts): Promise<string | null> {
    return this.resolveFromBeads(externalId, this.loadBeads());
  }

  resolveFromBeads(externalId: string, beads: BeadsRecord[]): string | null {
    const trimmed = externalId.trim();
    if (trimmed.length === 0) return null;
    const lookup = buildBeadsLookup(beads);
    const hit = lookup.byDomainExternalId.get("notion")?.get(trimmed.toLowerCase());
    return hit ? hit.id : null;
  }

  bulkClose(opts: { cwd: string; beadIds: readonly string[] }): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    for (const beadId of opts.beadIds) {
      const result = this.bdExec(
        {
          subcommand: "update",
          args: [beadId, "--status", "closed"],
          cwd: opts.cwd,
          state: "planning",
          role: "planner",
        },
        processEnv(),
      );
      if (result.stdout) stdoutParts.push(result.stdout);
      if (result.stderr) stderrParts.push(result.stderr);
      if (result.exitCode !== 0) {
        return {
          exitCode: result.exitCode,
          stdout: stdoutParts.join("\n"),
          stderr: stderrParts.join("\n"),
        };
      }
    }
    return {
      exitCode: 0,
      stdout: stdoutParts.join("\n"),
      stderr: stderrParts.join("\n"),
    };
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    };
  }
}

function hasFetchByPageId(
  resolver: NotionPageResolver | WorkUnitResolver,
): resolver is NotionPageResolver {
  return (
    typeof (resolver as Partial<NotionPageResolver>).fetchByPageId === "function"
  );
}

function paragraphChildrenFromText(text: string): unknown[] {
  return text.split(/\n\n+/).map((para) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: para } }],
    },
  }));
}

async function readJsonMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // fall through
  }
  return res.statusText || `status ${res.status}`;
}

/** The default Notion adapter singleton, registered on import. */
export const notionDomainAdapter = registerDomainAdapter(new NotionDomainAdapter());
