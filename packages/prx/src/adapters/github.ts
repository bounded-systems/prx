/**
 * GitHub domain adapter (GH-1536) — the first `DomainAdapter` implementation.
 *
 * Per the GH-1500 authority ADR: beads is canonical; GitHub issues are an
 * opt-in mirror target. This adapter wraps the existing low-level seams
 * (`defaultRunner` for gated `gh` I/O, `loadAllBeads` / `buildBeadsLookup` for
 * bd-record ⇄ external-id resolution) rather than re-implementing them.
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
 *   - `push(bd)`     — project the bd-authoritative fields (title / body /
 *                      axis labels / assignees / status) onto the GitHub issue;
 *                      create-if-missing (idempotent — dedup-checked,
 *                      write-back). GH-2382: the linked edit is lossless — it
 *                      reads the live issue and rewrites only divergent fields,
 *                      swapping the bd-axis `type::*`/`priority::*` labels
 *                      (a priority bump strips the stale rung) while preserving
 *                      foreign labels and GH-only markers, and returns a real
 *                      `edited` flag. The live read is reconciliation-only
 *                      (I-DS-PRIO / I-PROJ1) — never written back to bd.
 *   - `resolve(id)`  — external id (issue URL / `#N` / `N`) → bd short-id via
 *                      `buildBeadsLookup`. Never short-id prefix matching.
 *   - `bulkClose()`  — close every bd record in `beadIds` via the narrow
 *                      `execBdIssueClose` wrapper (GH-2011: the destructive
 *                      bd-side reconcile shell-out is retired; GH→bd close
 *                      flows through the same per-pair `adapter.pull`
 *                      detection + targeted close that bd-canonical
 *                      post-merge handoff uses).
 */

import { processEnv } from "@bounded-systems/env";
import {
  defaultRunner,
  repoNameWithOwner as defaultRepoNameWithOwner,
} from "../pr-state/github.ts";
import { buildBeadsLookup, extractIssueNumber } from "../issues/dedupe.ts";
import { extractIssueUrl } from "../tools/gh_issue_create.ts";
import {
  execBd as defaultExecBd,
  type BdExecResult,
} from "@bounded-systems/bd";
import { execBdIssueClose as defaultExecBdIssueClose } from "../tools/bd_issue_close.ts";
import {
  execGhIssueEdit as defaultExecGhIssueEdit,
  hasGhIssueEdit,
  type GhIssueEditOptions,
} from "../tools/gh_issue_edit.ts";
import { axisLabelDiff } from "../triage/bd-axis-labels.ts";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
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

const ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
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
  /** bd CLI exec. Defaults to `execBd`. */
  execBd?: typeof defaultExecBd | undefined;
  /** Loader for the full bd record set. Defaults to `loadAllBeads`. */
  loadAllBeads?: typeof defaultLoadAllBeads | undefined;
  /**
   * Narrow `bd close` wrapper. Defaults to `execBdIssueClose`. The bulkClose
   * loop calls this once per bead id (GH-2011).
   */
  execBdIssueClose?: typeof defaultExecBdIssueClose | undefined;
  /**
   * GH-2382 — narrow `gh issue edit` wrapper. Defaults to `execGhIssueEdit`.
   * The linked `push()` path routes its lossless title/body/label/assignee
   * edit through here so every bd→GH issue edit shares one rate-limit-gated
   * chokepoint (mirrors how `bulkClose` routes through `execBdIssueClose`).
   */
  execGhIssueEdit?: typeof defaultExecGhIssueEdit | undefined;
  /** OWNER/REPO resolver. Defaults to `repoNameWithOwner`. */
  repoNameWithOwner?: ((path: string) => string) | undefined;
  /** cwd source. Defaults to `process.cwd`. */
  cwd?: (() => string) | undefined;
  /**
   * GH-1595 — drop the per-invocation `BeadsCache` after the adapter's
   * write-back path (`bd update --external-ref` inside `push()` for an
   * unlinked record). When this adapter is constructed from `runBeadsSync`,
   * the cache is shared with every other `loadAllBeads`-shaped caller in the
   * run; `push()` writes change the cached read, so we drop it on success.
   */
  invalidateBeadsCache?: (() => void) | undefined;
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
export const GH_OWNED_ON_PULL = [
  "externalIssueNumber",
  "milestone",
  "status",
] as const;

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

  private get bdExec(): typeof defaultExecBd {
    return this.deps.execBd ?? defaultExecBd;
  }

  private loadBeads(): BeadsRecord[] {
    // GH-1595: when the cache-backed loader is injected (via `runBeadsSync`
    // or the `runCli` entry point), it ignores the `execBd` arg and returns
    // a memoized snapshot — the loop in `prx beads sync` shares one read
    // across every per-pair `push`/`resolve`.
    const loader = this.deps.loadAllBeads ?? defaultLoadAllBeads;
    return loader(this.deps.execBd ?? defaultExecBd);
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

  private runGh(args: string[], opts?: AdapterIoOpts): { stdout: string; stderr: string; status: number } {
    const runner = opts?.runner ?? this.runner;
    return runner(["gh", ...args], { cwd: opts?.cwd ?? (this.deps.cwd ?? (() => process.cwd()))(), check: false });
  }

  async pull(externalId: string, opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
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
    const r = parsed as Record<string, unknown>;
    const issueNumber =
      typeof r.number === "number" && Number.isFinite(r.number) ? r.number : number;
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

    // --- Unlinked: dedup-check, then create + write-back.
    const records = this.loadBeads();
    // A bd record other than `bd` already mirrored to a GitHub issue with the
    // exact same title is a likely duplicate — refuse rather than create one
    // (feedback: check dedup before promoting). Title-exact is the fallback;
    // the URL match is handled by the `bd.externalRef` linked path above.
    const titleDuplicate = records.find(
      (r) => r.id !== bd.id && r.externalIssueNumber !== null && r.title === bd.title,
    );
    if (titleDuplicate) {
      throw new GhDomainAdapterError(
        `gh adapter push: refusing to create a duplicate GitHub issue — bd ${titleDuplicate.id} ` +
          `is already mirrored to issue #${titleDuplicate.externalIssueNumber} with the same title; ` +
          `resolve the duplicate first`,
      );
    }

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
    // Write-back: bd update <id> --external-ref <url>.
    const updateResult: BdExecResult = this.bdExec(
      {
        subcommand: "update",
        args: [bd.id, "--external-ref", issueUrl],
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    if (updateResult.exitCode !== 0) {
      const detail =
        updateResult.stderr.trim() || updateResult.stdout.trim() || "bd update failed";
      throw new GhDomainAdapterError(
        `gh adapter push: created ${issueUrl} but bd write-back failed: ${detail}`,
        updateResult.exitCode || 1,
      );
    }
    this.deps.invalidateBeadsCache?.();
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
      const desired = new Set(
        fields.assignees!.map((a) => a.trim()).filter((a) => a.length > 0),
      );
      const add = [...desired].filter((a) => !liveAssignees.has(a));
      const remove = [...liveAssignees].filter((a) => !desired.has(a));
      if (add.length > 0) editOpts.addAssignees = add;
      if (remove.length > 0) editOpts.removeAssignees = remove;
    }

    const wantsStatusChange =
      needStatus && liveState !== "unknown" && liveState !== fields.status;
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
        const detail =
          result.stderr.trim() || result.stdout.trim() || `gh issue ${verb} failed`;
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
  async enumerate(
    range: EnumerateRange,
    opts?: AdapterIoOpts,
  ): Promise<ExternalRecordRef[]> {
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
      throw new GhDomainAdapterError("gh adapter enumerate: gh issue list --json returned invalid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new GhDomainAdapterError("gh adapter enumerate: gh issue list --json returned non-array");
    }
    const refs: ExternalRecordRef[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const number = typeof r.number === "number" && Number.isFinite(r.number) ? r.number : null;
      if (number === null || number < from || number > to) continue;
      const url = typeof r.url === "string" && r.url.length > 0
        ? r.url
        : `https://github.com/${repo}/issues/${number}`;
      const rawState = typeof r.state === "string" ? r.state.toUpperCase() : "";
      const state: "open" | "closed" | undefined =
        rawState === "OPEN" ? "open" : rawState === "CLOSED" ? "closed" : undefined;
      refs.push({ externalId: url, surfaceId: `GH-${number}`, number, ...(state ? { state } : {}) });
    }
    refs.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    return refs;
  }

  async resolve(externalId: string, _opts?: AdapterIoOpts): Promise<string | null> {
    return this.resolveFromBeads(externalId, this.loadBeads());
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

  /**
   * Close-apply for the per-pair sync verb. Loops the narrow `bd close`
   * wrapper (`execBdIssueClose`) over `beadIds` — each bead flagged by the
   * per-pair `adapter.pull` (`GH_OWNED_ON_PULL` includes `status`) as having
   * a CLOSED GH issue is closed in bd here.
   *
   * GH-2011: this replaces the previous repo-wide `bd github sync --pull-only
   * --prefer-github` shell-out, which dropped bd-only writes for
   * `issue_type`/`assignee`/`state`/`close_reason` while reconciling. The
   * targeted close stays inside the bd-canonical authority boundary.
   */
  bulkClose(opts: { cwd: string; beadIds: readonly string[] }): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    const close = this.deps.execBdIssueClose ?? defaultExecBdIssueClose;
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let worstExit = 0;
    for (const beadId of opts.beadIds) {
      const result = close({ id: beadId, cwd: opts.cwd, reason: "closed-by-pull" });
      if (result.stdout) stdoutParts.push(result.stdout);
      if (result.stderr) stderrParts.push(result.stderr);
      if (result.exitCode !== 0 && worstExit === 0) {
        worstExit = result.exitCode;
      }
    }
    return {
      exitCode: worstExit,
      stdout: stdoutParts.join("\n"),
      stderr: stderrParts.join("\n"),
    };
  }
}

/** The default GitHub adapter singleton, registered on import. */
export const githubDomainAdapter = registerDomainAdapter(new GhDomainAdapter());
