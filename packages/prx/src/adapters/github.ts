/**
 * GitHub domain adapter (GH-1536) — the first `DomainAdapter` implementation.
 *
 * GitHub issues are the write plane; the Front Desk read plane owns the
 * external-id ⇄ canonical-id map. This adapter wraps the gated `gh` CLI
 * (`defaultRunner` for rate-limited I/O) — create / edit / close / enumerate —
 * and resolves external ids against a Front-Desk record snapshot the caller
 * supplies (`resolveFromBeads`), rather than loading one itself.
 *
 * Field ownership (`ownedOnPull`) is the ADR §2 GitHub column — see
 * `docs/spikes/GH-1500-authority.md`. The `ownedOnPull` assertion in
 * `test/adapters/github.test.ts` pins the doc and the code together.
 *
 *   - `pull(url)`    — `gh issue view <n> --json number,url,state,assignees,milestone`
 *                      → the GitHub-owned patch (issue number, status,
 *                      assignees, milestone). Routed through the GH-1141
 *                      rate-limit gate (`defaultRunner`); budget-exhaustion
 *                      errors propagate typed.
 *   - `push(bd)`     — project the caller-authoritative fields (title / body /
 *                      axis labels / assignees / status) onto the GitHub issue;
 *                      create-if-missing. GH-2382: the linked edit is lossless —
 *                      it reads the live issue and rewrites only divergent
 *                      fields, swapping the `type::*`/`priority::*` axis labels
 *                      (a priority bump strips the stale rung) while preserving
 *                      foreign labels and GH-only markers, and returns a real
 *                      `edited` flag.
 *   - `resolve(id)`  — external id (issue URL / `#N` / `N`) → canonical short-id
 *                      via `resolveFromBeads` over a caller-supplied Front-Desk
 *                      snapshot. Never short-id prefix matching.
 */

import {
  defaultRunner,
  repoNameWithOwner as defaultRepoNameWithOwner,
} from "../pr-state/github.ts";
import { buildBeadsLookup, extractIssueNumber } from "../issues/dedupe.ts";
import { extractIssueUrl } from "../tools/gh_issue_create.ts";
import {
  execGhIssueEdit as defaultExecGhIssueEdit,
  hasGhIssueEdit,
  type GhIssueEditOptions,
} from "../tools/gh_issue_edit.ts";
import { axisLabelDiff } from "../triage/bd-axis-labels.ts";
import { parseConditionalRead } from "../sync/conditional-read.ts";
import { type BeadsRecord } from "../triage/triage.ts";
import {
  GH_SURFACE_ID_PATTERN,
  registerDomainAdapter,
  type AdapterCommandRunner,
  type AdapterIoOpts,
  type DomainAdapter,
  type DomainAdapterConfig,
  type DomainPushFields,
  type DomainPushResult,
  type EnumerateRange,
  type ExternalRecordRef,
  type ResolvedWorkUnitPatch,
} from "./domain-adapter.ts";

const ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
const SURFACE_ID_RE = /^GH-(\d+)$/i;

// GH-1469 — `gh issue list` row cap for `enumerate()`. Issues are listed
// most-recent first; the in-process `[from, to]` filter is the source of
// truth for membership, so the cap only needs to be large enough to reach an
// older `from`. Generous by design — backfill is an occasional operator verb,
// not a hot path.
const GH_ENUMERATE_LIST_LIMIT = 100000;

/**
 * GH-2382 — result of `GhDomainAdapter.reconcileLinked`. `edited` is the real
 * touched flag (or, on `dryRun`, whether a real run *would* write);
 * `addLabels`/`removeLabels` carry the planned bd-axis label swap so callers
 * (notably `prx beads publish --dry-run`) can render the change.
 */
export type LinkedReconcileResult = {
  externalId: string;
  edited: boolean;
  addLabels: string[];
  removeLabels: string[];
};

/**
 * GH-296 / prx-lzw — a cached conditional-read entry for one external issue:
 * the last ETag GitHub returned plus the `ResolvedWorkUnitPatch` JSON we derived
 * from that response (reused verbatim on a `304`).
 */
export type GhConditionalReadEntry = { etag: string; value: string };

/**
 * The structural slice of the pull-etag store that `GhDomainAdapter` needs. The
 * adapter only reads/writes per-issue entries; `runBeadsSync` owns creating and
 * flushing the backing store, so the adapter never imports it (keeps the
 * adapter→sync edge a single pure-parser import, no cycle).
 */
export type GhConditionalReadCache = {
  get(externalId: string): GhConditionalReadEntry | undefined;
  set(externalId: string, entry: GhConditionalReadEntry): void;
};

export class GhDomainAdapterError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "GhDomainAdapterError";
    this.exitCode = exitCode;
  }
}

export type GhDomainAdapterDeps = {
  /** Rate-limit-gated `gh`/CLI runner. Defaults to `defaultRunner`. */
  runner?: AdapterCommandRunner | undefined;
  /**
   * GH-2382 — narrow `gh issue edit` wrapper. Defaults to `execGhIssueEdit`.
   * The linked `push()` path routes its lossless title/body/label/assignee
   * edit through here so every GH issue edit shares one rate-limit-gated
   * chokepoint.
   */
  execGhIssueEdit?: typeof defaultExecGhIssueEdit | undefined;
  /** OWNER/REPO resolver. Defaults to `repoNameWithOwner`. */
  repoNameWithOwner?: ((path: string) => string) | undefined;
  /**
   * GH-296 / prx-lzw (lever 1) — per-issue conditional-read cache (last
   * `If-None-Match` etag + the patch JSON derived from that response). When
   * wired (by `runBeadsSync`'s pull leg), `pull()` issues a GitHub conditional
   * request via `gh api … -i` and reuses the cached patch on a free `304`,
   * cutting the reconcile's per-tick rate-limit spend on unchanged issues.
   * Absent (the default) ⇒ `pull()` does an unconditional `gh issue view`
   * (unchanged behavior).
   */
  conditionalRead?: GhConditionalReadCache | undefined;
  /** cwd source. Defaults to `process.cwd`. */
  cwd?: (() => string) | undefined;
};

// ADR §2 GitHub column — these BeadsRecord-keyed fields are GitHub-owned on
// pull. `externalIssueNumber`: the GH→bd one-shot at file time. `milestone`:
// GitHub-owned (no bd home yet — see ResolvedWorkUnitPatch / GH-1538).
// `status`: open/closed mirrored.
//
// GH-1874: `assignees` left this set when `prx delegate agent` made bd
// canonical for the assignee field. The inbound `pull()` still reports GH
// assignees on its patch shape, but the periodic reconcile no longer
// projects them back into bd — bd's `assignee` column is now authoritative
// and rides bd→external via `push()`.
//
// Editing this list MUST be accompanied by an edit to
// docs/spikes/GH-1500-authority.md §2 — the test suite asserts byte-equality.
export const GH_OWNED_ON_PULL = ["externalIssueNumber", "milestone", "status"] as const;

export class GhDomainAdapter implements DomainAdapter {
  readonly config: DomainAdapterConfig;

  private readonly deps: Required<Pick<GhDomainAdapterDeps, "cwd">> & GhDomainAdapterDeps;

  constructor(deps: GhDomainAdapterDeps = {}) {
    this.config = {
      domain: "gh",
      surfaceIdPattern: GH_SURFACE_ID_PATTERN,
      externalIdShape: "issue-url",
      ownedOnPull: GH_OWNED_ON_PULL,
    };
    this.deps = { ...deps, cwd: deps.cwd ?? (() => process.cwd()) };
  }

  private get runner(): AdapterCommandRunner {
    return this.deps.runner ?? (defaultRunner as AdapterCommandRunner);
  }

  private resolveRepo(repo: string | undefined, cwd: string | undefined): string {
    if (repo && repo.trim().length > 0) return repo.trim();
    const looked = (this.deps.repoNameWithOwner ?? defaultRepoNameWithOwner)(
      cwd ?? (this.deps.cwd ?? (() => process.cwd()))(),
    ).trim();
    if (!looked) {
      throw new GhDomainAdapterError(
        "gh adapter: could not resolve OWNER/REPO from cwd (gh repo view returned empty)",
      );
    }
    return looked;
  }

  matchesSurfaceId(id: string): boolean {
    return GH_SURFACE_ID_PATTERN.test(id.trim());
  }

  recognizesExternalId(externalId: string): boolean {
    if (typeof externalId !== "string") return false;
    return ISSUE_URL_RE.test(externalId.trim());
  }

  surfaceIdToExternalId(id: string, repoCtx?: { repo?: string; cwd?: string }): string {
    const match = id.trim().match(SURFACE_ID_RE);
    if (!match) {
      throw new GhDomainAdapterError(`gh adapter: not a GH-<n> surface id: ${id}`);
    }
    const repo = this.resolveRepo(repoCtx?.repo, repoCtx?.cwd);
    return `https://github.com/${repo}/issues/${Number.parseInt(match[1]!, 10)}`;
  }

  /** Parse `externalId` (issue URL / `GH-N` / `#N` / bare `N`) → `{ repo?, number }`. */
  private parseExternalId(externalId: string): { repo: string | null; number: number } {
    const trimmed = externalId.trim();
    const urlMatch = trimmed.match(ISSUE_URL_RE);
    if (urlMatch) {
      return { repo: urlMatch[1]!, number: Number.parseInt(urlMatch[2]!, 10) };
    }
    const numFromRef = extractIssueNumber(trimmed);
    if (numFromRef !== null) return { repo: null, number: numFromRef };
    const bare = trimmed.match(/^(?:GH-#?|#)?(\d+)$/i);
    if (bare) return { repo: null, number: Number.parseInt(bare[1]!, 10) };
    throw new GhDomainAdapterError(
      `gh adapter: not a GitHub issue id (URL, GH-N, #N, or N): ${externalId}`,
    );
  }

  private runGh(
    args: string[],
    opts?: AdapterIoOpts,
  ): { stdout: string; stderr: string; status: number } {
    const runner = opts?.runner ?? this.runner;
    return runner(["gh", ...args], {
      cwd: opts?.cwd ?? (this.deps.cwd ?? (() => process.cwd()))(),
      check: false,
    });
  }

  /**
   * Map a GitHub issue object (from `gh issue view --json` OR the REST
   * `/issues/{n}` body) to the GitHub-owned patch. Tolerant of both shapes:
   * `state` is upper/lowercased the same way; `assignees`/`milestone` are
   * `{login}` / `{title}` in both.
   */
  private parseIssuePatch(
    r: Record<string, unknown>,
    fallbackNumber: number,
  ): ResolvedWorkUnitPatch {
    const issueNumber =
      typeof r.number === "number" && Number.isFinite(r.number) ? r.number : fallbackNumber;
    const state = typeof r.state === "string" ? r.state.toUpperCase() : "";
    const status = state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : "unknown";
    const assignees = Array.isArray(r.assignees)
      ? r.assignees
          .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>).login : null))
          .filter((login): login is string => typeof login === "string")
      : [];
    const milestone =
      r.milestone && typeof r.milestone === "object"
        ? (() => {
            const title = (r.milestone as Record<string, unknown>).title;
            return typeof title === "string" ? title : null;
          })()
        : null;
    return { externalIssueNumber: issueNumber, status, assignees, milestone };
  }

  async pull(externalId: string, opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
    if (this.deps.conditionalRead) {
      return this.pullConditional(externalId, this.deps.conditionalRead, opts);
    }
    const { repo, number } = this.parseExternalId(externalId);
    const args = [
      "issue",
      "view",
      String(number),
      "--json",
      "number,url,state,assignees,milestone",
    ];
    if (repo) args.push("-R", repo);
    const result = this.runGh(args, opts);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "gh issue view failed";
      throw new GhDomainAdapterError(`gh adapter pull: ${detail}`, result.status || 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new GhDomainAdapterError("gh adapter pull: gh issue view --json returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GhDomainAdapterError("gh adapter pull: gh issue view --json returned non-object");
    }
    return this.parseIssuePatch(parsed as Record<string, unknown>, number);
  }

  /**
   * GH-296 / prx-lzw (lever 1) — the conditional-read pull. Issues
   * `gh api repos/{owner}/{repo}/issues/{n} -i [-H "If-None-Match: <etag>"]`:
   *   - `304 Not Modified` (free against the rate limit) ⇒ reuse the cached
   *     patch — GitHub is authoritative on changed-vs-unchanged, so this is
   *     provably correct, not a heuristic.
   *   - `2xx` ⇒ parse the fresh REST body, cache `{etag, patch}`, return it.
   *   - anything else ⇒ throw (same failure surface as the unconditional path).
   * `gh api` exits non-zero on BOTH a 304 and a real error, so the decision is
   * made from the HTTP status line (see `parseConditionalRead`), never the code.
   */
  private async pullConditional(
    externalId: string,
    cache: GhConditionalReadCache,
    opts?: AdapterIoOpts,
  ): Promise<ResolvedWorkUnitPatch> {
    const { repo, number } = this.parseExternalId(externalId);
    // `gh api` fills `{owner}/{repo}` from the base repo when none is in the
    // path — covers a bare `#N`/`N` id; sync ids are issue URLs (repo set).
    const path = repo ? `repos/${repo}/issues/${number}` : `repos/{owner}/{repo}/issues/${number}`;
    const cached = cache.get(externalId);

    const decision = this.apiRead(path, cached?.etag, opts);
    if (decision.kind === "not-modified") {
      // A 304 is only possible when we sent If-None-Match ⇒ `cached` exists.
      const patch = cached ? this.deserializeCachedPatch(cached.value) : undefined;
      if (patch) return patch;
      // Cache value unusable (shouldn't happen — we wrote it) ⇒ refetch fresh,
      // unconditionally (no If-None-Match), and re-derive.
      return this.applyFreshRead(externalId, number, this.apiRead(path, undefined, opts), cache);
    }
    return this.applyFreshRead(externalId, number, decision, cache);
  }

  /** Run `gh api <path> -i [-H "If-None-Match: <etag>"]` → a classified result. */
  private apiRead(
    path: string,
    etag: string | undefined,
    opts?: AdapterIoOpts,
  ): ReturnType<typeof parseConditionalRead> {
    const args = ["api", path, "-i"];
    if (etag && etag.length > 0) args.push("-H", `If-None-Match: ${etag}`);
    const result = this.runGh(args, opts);
    return parseConditionalRead({
      exitCode: result.status,
      output: result.stdout.includes("HTTP/")
        ? result.stdout
        : `${result.stdout}\n${result.stderr}`.trim(),
    });
  }

  /** Turn a fresh (`modified`/`error`) conditional read into a patch, caching it. */
  private applyFreshRead(
    externalId: string,
    fallbackNumber: number,
    decision: ReturnType<typeof parseConditionalRead>,
    cache: GhConditionalReadCache,
  ): ResolvedWorkUnitPatch {
    if (decision.kind === "modified") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decision.body);
      } catch {
        throw new GhDomainAdapterError("gh adapter pull: gh api returned invalid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new GhDomainAdapterError("gh adapter pull: gh api returned a non-object body");
      }
      const patch = this.parseIssuePatch(parsed as Record<string, unknown>, fallbackNumber);
      // Only cache with a usable etag — without one we can't condition the next
      // read, so don't poison the cache with an empty If-None-Match.
      if (decision.etag && decision.etag.length > 0) {
        cache.set(externalId, { etag: decision.etag, value: JSON.stringify(patch) });
      }
      return patch;
    }
    if (decision.kind === "error") {
      throw new GhDomainAdapterError(`gh adapter pull: ${decision.detail}`, decision.status ?? 1);
    }
    // not-modified on an unconditional read is impossible — surface it loudly.
    throw new GhDomainAdapterError("gh adapter pull: unexpected 304 on an unconditional read");
  }

  /** Parse a cached patch JSON; undefined when absent/corrupt (⇒ force refetch). */
  private deserializeCachedPatch(value: string): ResolvedWorkUnitPatch | undefined {
    if (!value || value.length === 0) return undefined;
    try {
      const obj = JSON.parse(value) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as ResolvedWorkUnitPatch;
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  async push(
    bd: BeadsRecord,
    fields: DomainPushFields,
    opts?: AdapterIoOpts,
  ): Promise<DomainPushResult> {
    const labels = (fields.labels ?? []).map((l) => l.trim()).filter((l) => l.length > 0);

    // --- Linked: idempotent, lossless edit of the requested bd-authoritative
    // fields. Delegates to the synchronous `reconcileLinked` core (shared with
    // `prx beads publish` so the two derive an identical projection).
    if (bd.externalRef && bd.externalRef.trim().length > 0) {
      const reconciled = this.reconcileLinked(bd.externalRef, fields, opts);
      return { externalId: reconciled.externalId, created: false, edited: reconciled.edited };
    }

    // --- Unlinked: create the GitHub issue (the write plane). The external id
    // is returned to the caller, which owns linking it back in the Front Desk
    // read plane; there is no bd write-back here.
    const repo = this.resolveRepo(undefined, opts?.cwd);
    const createArgs = ["issue", "create", "-R", repo, "--title", fields.title ?? bd.title];
    if (typeof fields.body === "string") createArgs.push("--body", fields.body);
    else if (bd.description) createArgs.push("--body", bd.description);
    for (const label of labels) createArgs.push("--label", label);
    const created = this.runGh(createArgs, opts);
    if (created.status !== 0) {
      const detail = created.stderr.trim() || created.stdout.trim() || "gh issue create failed";
      throw new GhDomainAdapterError(`gh adapter push: ${detail}`, created.status || 1);
    }
    const issueUrl = extractIssueUrl(created.stdout);
    if (!issueUrl) {
      throw new GhDomainAdapterError(
        `gh adapter push: gh issue create stdout did not contain an issue URL: ${created.stdout.trim()}`,
      );
    }
    return { externalId: issueUrl, created: true, edited: true };
  }

  /**
   * GH-2382 — the synchronous lossless linked-edit core, shared by
   * `push()` (the `bd.externalRef`-set branch) and `prx beads publish`
   * (`publishOne`). Reads the live issue once and rewrites only the divergent
   * bd-authoritative fields:
   *
   *   - title / body — emitted only when they differ from the live values;
   *   - labels — the bd-axis swap (`axisLabelDiff`): a priority/type change
   *     strips the stale rung and adds the new one, preserving foreign labels
   *     and GH-only `type::spike`/`decision` markers;
   *   - assignees — the GH-1874 add/remove delta against the live set;
   *   - status — an honored reopen/close (a distinct gh subcommand) when the
   *     bd state diverges from live.
   *
   * Every field is field-by-field idempotent — a `fields` value of `undefined`
   * reads nothing and writes nothing. Direction-lock (I-DS-PRIO / I-PROJ1):
   * every live read here is GH-side reconciliation only — it never feeds a
   * bd-side write; the desired state is supplied by the (bd-authoritative)
   * caller. On `opts.dryRun` the read + diff run but no external write is
   * issued; `edited` then reports whether a real run *would* have written, and
   * `addLabels`/`removeLabels` carry the planned label swap for rendering. The
   * `gh issue edit` itself routes through the narrow `execGhIssueEdit`
   * chokepoint (GH-2382).
   */
  reconcileLinked(
    externalRef: string,
    fields: DomainPushFields,
    opts?: AdapterIoOpts,
  ): LinkedReconcileResult {
    const { repo, number } = this.parseExternalId(externalRef);
    const dryRun = opts?.dryRun === true;
    const desiredLabels =
      fields.labels === undefined
        ? undefined
        : fields.labels.map((l) => l.trim()).filter((l) => l.length > 0);
    const needTitle = typeof fields.title === "string";
    const needBody = typeof fields.body === "string";
    const needAssignees = fields.assignees !== undefined;
    const needLabels = desiredLabels !== undefined;
    const needStatus = fields.status !== undefined;

    // One combined live read for whichever fields need reconciling, so each
    // field is only rewritten when it actually diverges (a true `edited` flag,
    // and a clean re-run is a real no-op). The `--json` field list is built
    // dynamically so an assignees-only push still issues exactly
    // `--json assignees` (minimal read).
    let liveTitle: string | null = null;
    let liveBody: string | null = null;
    let liveAssignees = new Set<string>();
    let liveLabels: string[] = [];
    let liveState: "open" | "closed" | "unknown" = "unknown";
    const jsonFields: string[] = [];
    if (needTitle) jsonFields.push("title");
    if (needBody) jsonFields.push("body");
    if (needAssignees) jsonFields.push("assignees");
    if (needLabels) jsonFields.push("labels");
    if (needStatus) jsonFields.push("state");
    if (jsonFields.length > 0) {
      const viewArgs = ["issue", "view", String(number), "--json", jsonFields.join(",")];
      if (repo) viewArgs.push("-R", repo);
      const view = this.runGh(viewArgs, opts);
      if (view.status !== 0) {
        const detail = view.stderr.trim() || view.stdout.trim() || "gh issue view failed";
        throw new GhDomainAdapterError(`gh adapter push: ${detail}`, view.status || 1);
      }
      let parsed: {
        title?: unknown;
        body?: unknown;
        assignees?: Array<{ login?: unknown }>;
        labels?: Array<{ name?: unknown }>;
        state?: unknown;
      };
      try {
        parsed = JSON.parse(view.stdout);
      } catch {
        throw new GhDomainAdapterError(
          "gh adapter push: gh issue view --json returned invalid JSON",
        );
      }
      if (needTitle) liveTitle = typeof parsed.title === "string" ? parsed.title : null;
      if (needBody) liveBody = typeof parsed.body === "string" ? parsed.body : null;
      if (needAssignees && Array.isArray(parsed.assignees)) {
        for (const a of parsed.assignees) {
          if (a && typeof a.login === "string") liveAssignees.add(a.login);
        }
      }
      if (needLabels && Array.isArray(parsed.labels)) {
        liveLabels = parsed.labels
          .map((l) => (l && typeof l.name === "string" ? l.name : null))
          .filter((n): n is string => n !== null);
      }
      if (needStatus) {
        const s = typeof parsed.state === "string" ? parsed.state.toUpperCase() : "";
        liveState = s === "CLOSED" ? "closed" : s === "OPEN" ? "open" : "unknown";
      }
    }

    const editOpts: GhIssueEditOptions = { number, ...(repo ? { repo } : {}) };
    if (needTitle && fields.title !== liveTitle) editOpts.title = fields.title;
    if (needBody && fields.body !== liveBody) editOpts.body = fields.body;
    let addLabels: string[] = [];
    let removeLabels: string[] = [];
    if (needLabels) {
      const diff = axisLabelDiff(liveLabels, desiredLabels!);
      addLabels = diff.add;
      removeLabels = diff.remove;
      if (addLabels.length > 0) editOpts.addLabels = addLabels;
      if (removeLabels.length > 0) editOpts.removeLabels = removeLabels;
    }
    if (needAssignees) {
      const desired = new Set(fields.assignees!.map((a) => a.trim()).filter((a) => a.length > 0));
      const add = [...desired].filter((a) => !liveAssignees.has(a));
      const remove = [...liveAssignees].filter((a) => !desired.has(a));
      if (add.length > 0) editOpts.addAssignees = add;
      if (remove.length > 0) editOpts.removeAssignees = remove;
    }

    const wantsStatusChange = needStatus && liveState !== "unknown" && liveState !== fields.status;
    const wouldEdit = hasGhIssueEdit(editOpts) || wantsStatusChange;
    if (dryRun) {
      return { externalId: externalRef.trim(), edited: wouldEdit, addLabels, removeLabels };
    }

    let edited = false;
    if (hasGhIssueEdit(editOpts)) {
      const editFn = this.deps.execGhIssueEdit ?? defaultExecGhIssueEdit;
      const editCwd = opts?.cwd ?? (this.deps.cwd ?? (() => process.cwd()))();
      const result = editFn({ ...editOpts, cwd: editCwd });
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || "gh issue edit failed";
        throw new GhDomainAdapterError(`gh adapter push: ${detail}`, result.exitCode || 1);
      }
      edited = true;
    }

    // Status reopen/close is a distinct gh subcommand (not `issue edit`).
    // Honored only when provided and divergent from the live state.
    if (wantsStatusChange) {
      const verb = fields.status === "closed" ? "close" : "reopen";
      const statusArgs = ["issue", verb, String(number)];
      if (repo) statusArgs.push("-R", repo);
      const result = this.runGh(statusArgs, opts);
      if (result.status !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `gh issue ${verb} failed`;
        throw new GhDomainAdapterError(`gh adapter push: ${detail}`, result.status || 1);
      }
      edited = true;
    }

    return { externalId: externalRef.trim(), edited, addLabels, removeLabels };
  }

  /**
   * GH-1469 — enumerate GitHub issues over `[from, to]` (the `prx sync
   * backfill` discovery seam). One gated `gh issue list` invocation (issues
   * only — `gh issue list` excludes PRs), filtered to the requested number
   * range in-process. Read-only: never writes bd/gh, never advances the
   * watermark/cursor (I-BF3).
   */
  async enumerate(range: EnumerateRange, opts?: AdapterIoOpts): Promise<ExternalRecordRef[]> {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const repo = this.resolveRepo(undefined, opts?.cwd);
    // `--limit` is gh's hard cap on rows returned; issues are listed
    // most-recent first, so a generous cap is needed to reach an older
    // `from`. The range filter below is the source of truth for membership.
    const args = [
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "all",
      "--limit",
      String(GH_ENUMERATE_LIST_LIMIT),
      "--json",
      "number,url,state",
    ];
    const result = this.runGh(args, opts);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "gh issue list failed";
      throw new GhDomainAdapterError(`gh adapter enumerate: ${detail}`, result.status || 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new GhDomainAdapterError(
        "gh adapter enumerate: gh issue list --json returned invalid JSON",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new GhDomainAdapterError(
        "gh adapter enumerate: gh issue list --json returned non-array",
      );
    }
    const refs: ExternalRecordRef[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const number = typeof r.number === "number" && Number.isFinite(r.number) ? r.number : null;
      if (number === null || number < from || number > to) continue;
      const url =
        typeof r.url === "string" && r.url.length > 0
          ? r.url
          : `https://github.com/${repo}/issues/${number}`;
      const rawState = typeof r.state === "string" ? r.state.toUpperCase() : "";
      const state: "open" | "closed" | undefined =
        rawState === "OPEN" ? "open" : rawState === "CLOSED" ? "closed" : undefined;
      refs.push({
        externalId: url,
        surfaceId: `GH-${number}`,
        number,
        ...(state ? { state } : {}),
      });
    }
    refs.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    return refs;
  }

  async resolve(externalId: string, _opts?: AdapterIoOpts): Promise<string | null> {
    // The external-id → canonical-id map lives in the Front Desk read plane;
    // this adapter no longer loads a record snapshot itself. Callers that hold
    // a Front-Desk snapshot resolve through `resolveFromBeads(externalId,
    // snapshot)` (the only path anything exercises). Absent a snapshot there is
    // nothing to resolve against, so an id reads as unmirrored.
    return this.resolveFromBeads(externalId, []);
  }

  resolveFromBeads(externalId: string, beads: BeadsRecord[]): string | null {
    let parsed: { repo: string | null; number: number };
    try {
      parsed = this.parseExternalId(externalId);
    } catch {
      return null;
    }
    const trimmed = externalId.trim();
    const lookup = buildBeadsLookup(beads);
    if (ISSUE_URL_RE.test(trimmed)) {
      const hit = lookup.byDomainExternalId.get("gh")?.get(trimmed.toLowerCase());
      if (hit) return hit.id;
    }
    const byNumber = lookup.byIssueNumber.get(parsed.number);
    return byNumber ? byNumber.id : null;
  }
}

/** The default GitHub adapter singleton, registered on import. */
export const githubDomainAdapter = registerDomainAdapter(new GhDomainAdapter());
