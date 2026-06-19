/**
 * `prx publisher` — PR publication transitions (GH-1559 + GH-1398 ADR §4).
 *
 * The publisher is the verification_publication-tier actor that *owns* the
 * three PR publication-transition intents. These verbs moved off `prx doctor`
 * per the GH-1398 read/diagnose-vs-publish split: `doctor` keeps `inventory`
 * (read-only diagnosis + the shared I04 gate primitives), `publisher` drives
 * the guarded transitions back through `gh`'s GraphQL surface.
 *
 * Surface:
 *   prx publisher merge [GH-NNN] [--method ...] — gate against I04, then enable automerge
 *   prx publisher ready [GH-NNN]                — gate light, then markPullRequestReadyForReview
 *   prx publisher draft [GH-NNN]                — convertPullRequestToDraft (no gate)
 *
 * The gate logic (`gateTransition`), inventory projection (`loadInventory`),
 * and blocker partitioning (`partitionBlockers`) are shared with
 * `prx doctor inventory` and imported from `./doctor.ts` — moved-not-copied:
 * the executable form of invariant **I04** lives in exactly one place.
 *
 * Each successful transition emits the matching intent event
 * (`PR_AUTOMERGE_REQUESTED` / `PR_READY_REQUESTED` / `PR_DRAFT_REQUESTED`)
 * through `recordEvent`, which derives the owning actor (`publisher`) from
 * `eventOwnerMap` and stamps the `workUnitId` onto the audit row.
 */

import type { AuditSinkDeps } from "../audit/sink.ts";
import { recordEvent } from "../machine/record_event.ts";
import {
  execGhIssueEdit as defaultExecGhIssueEdit,
  hasGhIssueEdit,
  type GhIssueEditOptions,
} from "../tools/gh_issue_edit.ts";
import {
  type DoctorBlocker,
  type DoctorDeps,
  type DoctorGateResult,
  type DoctorMergeMethod,
  type DoctorMergeOptions,
  type DoctorOutput,
  type DoctorTarget,
  type DoctorVerb,
  gateTransition,
  loadInventory,
  partitionBlockers,
} from "./doctor.ts";
import {
  type CommandRunner,
  convertPrToDraft,
  defaultRunner,
  enableAutoMerge,
  markPrReadyForReview,
  mergePullRequest,
  resolvePrNodeId,
} from "./github.ts";
// GH-1560: `pr open` renders its body (Closes #N / Refs) with the same template
// `prx submit body-template` / `gh pr create --body-file` consumers use.
import { formatBodyTemplateRender, renderBodyTemplate } from "../submit/body-template.ts";

import type { DoctorInventory } from "./doctor.ts";

/**
 * Publisher verbs reuse the doctor's DI seams (inventory fetch, GraphQL
 * mutators, runner) and add the audit-sink seam so the intent-event emission
 * is mockable in tests (GH-1616 `recordEvent` substrate).
 */
export type PublisherDeps = DoctorDeps & {
  /** Audit-sink DI seam for the intent-event emission (GH-1616). */
  auditDeps?: AuditSinkDeps | undefined;
};

/**
 * Map a waiting predicate to its bucket name for the success-line summary
 * (`waiting on: ci, review`). Hard-blocker predicates never reach this path.
 */
function waitingCategory(predicate: string): string {
  if (predicate.startsWith("signals.ci.")) return "ci";
  if (predicate.startsWith("signals.review.")) return "review";
  if (predicate.startsWith("signals.mergeability.")) return "mergeability";
  return predicate;
}

function uniqueWaitingCategories(waiting: DoctorBlocker[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const w of waiting) {
    const cat = waitingCategory(w.predicate);
    if (!seen.has(cat)) {
      seen.add(cat);
      result.push(cat);
    }
  }
  return result;
}

function emitBlockers(
  output: DoctorOutput,
  verb: DoctorVerb,
  inventory: DoctorInventory,
  gate: DoctorGateResult,
): void {
  const { hard, waiting } = partitionBlockers(gate.blockers);
  if (hard.length > 0) {
    output.error(`prx publisher ${verb}: ${hard.length} blocker(s) on ${inventory.prUrl}:`);
    for (const blocker of hard) {
      output.error(`  - ${blocker.predicate}`);
      output.error(`    ${blocker.fixHint}`);
    }
  }
  if (waiting.length > 0) {
    output.error(
      `prx publisher ${verb}: ${waiting.length} waiting condition(s) on ${inventory.prUrl}:`,
    );
    for (const blocker of waiting) {
      output.error(`  - ${blocker.predicate}`);
      output.error(`    ${blocker.fixHint}`);
    }
  }
}

export function runUpdateBranch(
  target: DoctorTarget,
  prNumber: number,
  runner: CommandRunner,
): void {
  // gh CLI surface — we deliberately use the gh wrapper here (not the
  // GraphQL helpers) because update-branch is a high-level rebase operation,
  // not a single mutation. The gh CLI handles the merge-strategy plumbing.
  runner(["gh", "pr", "update-branch", String(prNumber)], { cwd: target.repoPath });
}

export function runMerge(
  target: DoctorTarget,
  options: DoctorMergeOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const method: DoctorMergeMethod = options.method ?? "SQUASH";
  const runner = deps.runner ?? defaultRunner;
  const enable = deps.enableAutoMerge ?? enableAutoMerge;
  const merge = deps.mergePullRequest ?? mergePullRequest;
  const resolveId = deps.resolvePrNodeId ?? resolvePrNodeId;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher merge: ${(err as Error).message}`);
    return 1;
  }

  // Behind-main retry: run `gh pr update-branch` once and reload inventory.
  if (inventory.behindBy > 0 && !options.noUpdateBranch) {
    output.log(
      `prx publisher merge: PR #${inventory.prNumber} is behind base; running gh pr update-branch...`,
    );
    try {
      runUpdateBranch(target, inventory.prNumber, runner);
    } catch (err) {
      output.error(`prx publisher merge: gh pr update-branch failed: ${(err as Error).message}`);
      return 1;
    }
    try {
      inventory = loadInventory(target, deps);
    } catch (err) {
      output.error(`prx publisher merge: ${(err as Error).message}`);
      return 1;
    }
  }

  const gate = gateTransition("merge", inventory);
  const { hard: hardBlockers, waiting: waitingItems } = partitionBlockers(gate.blockers);
  if (hardBlockers.length > 0) {
    // GH-1354: hard blockers veto. Waiting items, if any, render in the same
    // call as informational tail.
    emitBlockers(output, "merge", inventory, gate);
    return 1;
  }
  // 0 hard blockers; waiting items are exactly what enablePullRequestAutoMerge
  // is built to queue through. Fall through.

  if (inventory.autoMergeEnabled) {
    if (format === "json") {
      output.log(
        JSON.stringify(
          {
            target: target.workUnitId,
            inventory,
            alreadyEnabled: true,
            method: inventory.autoMergeMethod,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    output.log(
      `prx publisher merge: automerge already enabled on ${inventory.prUrl} (method=${inventory.autoMergeMethod ?? "?"})`,
    );
    return 0;
  }

  let prNodeId: string;
  try {
    prNodeId = resolveId(target.repoPath, inventory.prNumber, runner);
  } catch (err) {
    output.error(`prx publisher merge: could not resolve PR node id: ${(err as Error).message}`);
    return 1;
  }

  let path: "automerge" | "direct" = "automerge";
  let resultMethod: DoctorMergeMethod = method;
  let resultNodeId: string;
  try {
    const automergeResult = enable(target.repoPath, prNodeId, method, runner);
    resultNodeId = automergeResult.prNodeId;
    resultMethod = automergeResult.mergeMethod;
  } catch (err) {
    const msg = (err as Error).message;
    if (/clean status/i.test(msg)) {
      // GitHub refuses enableAutoMerge on a PR that's already in CLEAN state —
      // automerge is for queueing a future merge, so when there's nothing to
      // wait on it returns "Pull request is in clean status". Fall through
      // to a direct merge with the same method.
      if (format === "plain") {
        output.log(
          `prx publisher merge: PR is already mergeable; falling through to direct merge.`,
        );
      }
      try {
        const directResult = merge(target.repoPath, prNodeId, method, runner);
        resultNodeId = directResult.prNodeId;
        path = "direct";
      } catch (err2) {
        output.error(`prx publisher merge: mergePullRequest failed: ${(err2 as Error).message}`);
        return 1;
      }
    } else {
      output.error(`prx publisher merge: enablePullRequestAutoMerge failed: ${msg}`);
      return 1;
    }
  }

  // GH-1559: the gate passed and the mutation was requested — emit the
  // publisher-owned intent (eventOwnerMap attributes it to `publisher`).
  recordEvent("PR_AUTOMERGE_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  // GH-1354: when path === "automerge" and waiting items exist, the queued
  // mutation is parked behind those signals. Surface them so operators know
  // what GitHub is waiting on.
  const waitingForOutput = path === "automerge" ? waitingItems : [];
  const waitingPredicates = waitingForOutput.map((w) => w.predicate);
  const waitingCategories = uniqueWaitingCategories(waitingForOutput);

  if (format === "json") {
    output.log(
      JSON.stringify(
        {
          target: target.workUnitId,
          prUrl: inventory.prUrl,
          prNodeId: resultNodeId,
          method: resultMethod,
          path,
          waiting: waitingPredicates,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (path === "direct") {
    output.log(
      `prx publisher merge: merged ${inventory.prUrl} (method=${resultMethod.toLowerCase()})`,
    );
  } else if (waitingCategories.length > 0) {
    output.log(
      `prx publisher merge: automerge enabled on ${inventory.prUrl} (method=${resultMethod.toLowerCase()}; waiting on: ${waitingCategories.join(", ")})`,
    );
    for (const w of waitingForOutput) {
      output.log(`  - ${w.predicate}`);
    }
  } else {
    output.log(
      `prx publisher merge: automerge enabled on ${inventory.prUrl} (method=${resultMethod.toLowerCase()})`,
    );
  }
  return 0;
}

export function runReady(
  target: DoctorTarget,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;
  const resolveId = deps.resolvePrNodeId ?? resolvePrNodeId;
  const mark = deps.markPrReadyForReview ?? markPrReadyForReview;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher ready: ${(err as Error).message}`);
    return 1;
  }

  if (!inventory.isDraft) {
    if (format === "json") {
      output.log(
        JSON.stringify({ target: target.workUnitId, inventory, alreadyReady: true }, null, 2),
      );
      return 0;
    }
    output.log(`prx publisher ready: PR ${inventory.prUrl} is already out of draft`);
    return 0;
  }

  const gate = gateTransition("ready", inventory);
  if (!gate.ok) {
    emitBlockers(output, "ready", inventory, gate);
    return 1;
  }

  let prNodeId: string;
  try {
    prNodeId = resolveId(target.repoPath, inventory.prNumber, runner);
  } catch (err) {
    output.error(`prx publisher ready: could not resolve PR node id: ${(err as Error).message}`);
    return 1;
  }

  let result;
  try {
    result = mark(target.repoPath, prNodeId, runner);
  } catch (err) {
    output.error(
      `prx publisher ready: markPullRequestReadyForReview failed: ${(err as Error).message}`,
    );
    return 1;
  }

  // GH-1559: gate passed and the PR was marked ready — emit the intent.
  recordEvent("PR_READY_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify(
        {
          target: target.workUnitId,
          prUrl: inventory.prUrl,
          prNodeId: result.prNodeId,
          isDraft: result.isDraft,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(`prx publisher ready: ${inventory.prUrl} is now ready for review`);
  return 0;
}

export function runDraft(
  target: DoctorTarget,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;
  const resolveId = deps.resolvePrNodeId ?? resolvePrNodeId;
  const convert = deps.convertPrToDraft ?? convertPrToDraft;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher draft: ${(err as Error).message}`);
    return 1;
  }

  if (inventory.isDraft) {
    if (format === "json") {
      output.log(
        JSON.stringify({ target: target.workUnitId, inventory, alreadyDraft: true }, null, 2),
      );
      return 0;
    }
    output.log(`prx publisher draft: PR ${inventory.prUrl} is already a draft`);
    return 0;
  }

  let prNodeId: string;
  try {
    prNodeId = resolveId(target.repoPath, inventory.prNumber, runner);
  } catch (err) {
    output.error(`prx publisher draft: could not resolve PR node id: ${(err as Error).message}`);
    return 1;
  }

  let result;
  try {
    result = convert(target.repoPath, prNodeId, runner);
  } catch (err) {
    output.error(
      `prx publisher draft: convertPullRequestToDraft failed: ${(err as Error).message}`,
    );
    return 1;
  }

  // GH-1559: PR converted back to draft — emit the intent.
  recordEvent("PR_DRAFT_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify(
        {
          target: target.workUnitId,
          prUrl: inventory.prUrl,
          prNodeId: result.prNodeId,
          isDraft: result.isDraft,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(`prx publisher draft: ${inventory.prUrl} is now a draft`);
  return 0;
}

// GH-1560: `prx publisher pr open` — open a PR from scratch (NOT --from-cas,
// unlike `prx submit publish`). Draft by default (CI-pending-safe, GH-2267);
// `--ready` opts out. Title carries the trailing `(GH-N)` contract — the
// parenthetical does NOT auto-close (GH-1318); the body's `Closes #N`
// (rendered via the shared body template) is what closes the unit on merge.
export type PrOpenOptions = {
  /** Conventional-commit summary; `(GH-N)` is appended to form the PR title. */
  summary: string;
  /** Extra units to close/ref in the body (the work unit is always included). */
  closes?: string[] | undefined;
  /** Base branch (default `main`). */
  base?: string | undefined;
  /** Head branch (default the work-unit branch). */
  head?: string | undefined;
  /** Open ready-for-review instead of draft (only when CI is known-green). */
  ready?: boolean | undefined;
};

export function runPrOpen(
  target: DoctorTarget,
  options: PrOpenOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;
  const base = options.base ?? "main";
  const head = options.head ?? target.workUnitId;
  const title = `${options.summary} (${target.workUnitId})`.slice(0, 200);
  const body = formatBodyTemplateRender(
    renderBodyTemplate({
      closes: [target.workUnitId, ...(options.closes ?? [])],
      format: "plain",
    }),
    "plain",
  );
  const argv = [
    "gh",
    "pr",
    "create",
    // GH-2267: draft unless the caller opts into ready (CI known-green).
    ...(options.ready ? [] : ["--draft"]),
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ];
  const result = runner(argv, { cwd: target.repoPath });
  if (result.status !== 0) {
    output.error(
      `prx publisher pr open: gh pr create failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    );
    return result.status ?? 1;
  }
  recordEvent("PR_OPEN_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });
  const prUrl = (result.stdout ?? "").trim();
  if (format === "json") {
    output.log(
      JSON.stringify(
        { target: target.workUnitId, base, head, title, draft: !options.ready, prUrl },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(
    `prx publisher pr open: opened ${options.ready ? "ready" : "draft"} PR for ${target.workUnitId}${prUrl ? ` (${prUrl})` : ""}`,
  );
  return 0;
}

// GH-1560: `prx publisher pr update` — update-branch (rebase onto base) and,
// when `--title` is given, retitle (keeping the `(GH-N)` contract). Reuses the
// shared `runUpdateBranch` helper.
export type PrUpdateOptions = {
  /** New conventional-commit summary; `(GH-N)` re-appended. Omit to skip retitle. */
  title?: string | undefined;
};

export function runPrUpdate(
  target: DoctorTarget,
  options: PrUpdateOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher pr update: ${(err as Error).message}`);
    return 1;
  }

  runUpdateBranch(target, inventory.prNumber, runner);
  const retitled = options.title !== undefined && options.title.length > 0;
  if (retitled) {
    const newTitle = `${options.title} (${target.workUnitId})`.slice(0, 200);
    runner(["gh", "pr", "edit", String(inventory.prNumber), "--title", newTitle], {
      cwd: target.repoPath,
    });
  }

  recordEvent("PR_UPDATE_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify(
        { target: target.workUnitId, prUrl: inventory.prUrl, updatedBranch: true, retitled },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(`prx publisher pr update: updated ${inventory.prUrl}${retitled ? " (retitled)" : ""}`);
  return 0;
}

// ai-home-2ow2v: `prx publisher pr comment` — post a review comment on the
// work-unit's PR (`gh pr comment`). The forge-owned chokepoint so the author
// profile reaches it via dispatch instead of raw `gh pr comment`.
export type PrCommentOptions = {
  /** Comment body (required). */
  body: string;
};

export function runPrComment(
  target: DoctorTarget,
  options: PrCommentOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher pr comment: ${(err as Error).message}`);
    return 1;
  }

  const result = runner(
    ["gh", "pr", "comment", String(inventory.prNumber), "--body", options.body],
    { cwd: target.repoPath },
  );
  if (result.status !== 0) {
    output.error(
      `prx publisher pr comment: gh pr comment failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    );
    return result.status ?? 1;
  }

  recordEvent("PR_COMMENT_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify(
        { target: target.workUnitId, prUrl: inventory.prUrl, commented: true },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(`prx publisher pr comment: commented on ${inventory.prUrl}`);
  return 0;
}

// ai-home-2ow2v: `prx publisher pr edit` — edit the PR title and/or body
// (`gh pr edit`). Title gets the `(GH-N)` contract re-appended (mirroring
// `pr open` / `pr update`). Body is applied from a file (the author renders it
// via `prx author body-template`). At least one of title/bodyFile is required
// (enforced by the CLI parser).
export type PrEditOptions = {
  /** New conventional-commit summary; `(GH-N)` re-appended. Omit to skip. */
  title?: string | undefined;
  /** Path to a file whose contents become the new PR body. Omit to skip. */
  bodyFile?: string | undefined;
};

export function runPrEdit(
  target: DoctorTarget,
  options: PrEditOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherDeps = {},
): number {
  const runner = deps.runner ?? defaultRunner;

  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx publisher pr edit: ${(err as Error).message}`);
    return 1;
  }

  const argv = ["gh", "pr", "edit", String(inventory.prNumber)];
  const retitled = options.title !== undefined && options.title.length > 0;
  if (retitled) {
    argv.push("--title", `${options.title} (${target.workUnitId})`.slice(0, 200));
  }
  const editedBody = options.bodyFile !== undefined && options.bodyFile.length > 0;
  if (editedBody) {
    argv.push("--body-file", options.bodyFile!);
  }

  const result = runner(argv, { cwd: target.repoPath });
  if (result.status !== 0) {
    output.error(
      `prx publisher pr edit: gh pr edit failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    );
    return result.status ?? 1;
  }

  recordEvent("PR_EDIT_REQUESTED", {
    workUnitId: target.workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify(
        { target: target.workUnitId, prUrl: inventory.prUrl, retitled, editedBody },
        null,
        2,
      ),
    );
    return 0;
  }
  output.log(
    `prx publisher pr edit: edited ${inventory.prUrl}${retitled ? " (title)" : ""}${editedBody ? " (body)" : ""}`,
  );
  return 0;
}

// GH-2382: `publisher issueUpdate` — the bd→GH issue-edit verb. The single
// `gh issue edit` chokepoint that emits the `publisher`-owned
// `ISSUE_UPDATE_REQUESTED` intent (`eventOwnerMap` attributes it to
// `publisher`, stamping the `workUnitId` onto the audit row — I-AUD1). The
// `GhDomainAdapter.reconcileLinked` core computes the lossless add/remove
// diff; this verb is the operator-facing surface for a pre-computed edit.
export type IssueUpdateOptions = {
  /** Issue number to edit. */
  number: number;
  /** Optional --repo OWNER/REPO; when omitted gh uses the cwd's git remote. */
  repo?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  addLabels?: readonly string[] | undefined;
  removeLabels?: readonly string[] | undefined;
  addAssignees?: readonly string[] | undefined;
  removeAssignees?: readonly string[] | undefined;
};

export type PublisherIssueDeps = {
  /** Narrow `gh issue edit` wrapper. Defaults to `execGhIssueEdit`. */
  execGhIssueEdit?: typeof defaultExecGhIssueEdit | undefined;
  /** Audit-sink DI seam for the intent-event emission (GH-1616). */
  auditDeps?: AuditSinkDeps | undefined;
};

export function runIssueUpdate(
  workUnitId: string,
  options: IssueUpdateOptions,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: PublisherIssueDeps = {},
): number {
  const editFn = deps.execGhIssueEdit ?? defaultExecGhIssueEdit;
  const editOpts: GhIssueEditOptions = {
    number: options.number,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.addLabels ? { addLabels: options.addLabels } : {}),
    ...(options.removeLabels ? { removeLabels: options.removeLabels } : {}),
    ...(options.addAssignees ? { addAssignees: options.addAssignees } : {}),
    ...(options.removeAssignees ? { removeAssignees: options.removeAssignees } : {}),
  };

  if (!hasGhIssueEdit(editOpts)) {
    if (format === "json") {
      output.log(
        JSON.stringify({ target: workUnitId, number: options.number, edited: false }, null, 2),
      );
      return 0;
    }
    output.log(
      `prx publisher issue update: GH-${options.number} already in sync (no fields to edit)`,
    );
    return 0;
  }

  const result = editFn(editOpts);
  if (result.exitCode !== 0) {
    output.error(
      `prx publisher issue update: gh issue edit failed (${result.exitCode}): ${(result.stderr ?? "").trim()}`,
    );
    return result.exitCode || 1;
  }

  // GH-2382: the edit was requested — emit the publisher-owned intent.
  recordEvent("ISSUE_UPDATE_REQUESTED", {
    workUnitId,
    deps: deps.auditDeps,
  });

  if (format === "json") {
    output.log(
      JSON.stringify({ target: workUnitId, number: options.number, edited: true }, null, 2),
    );
    return 0;
  }
  output.log(`prx publisher issue update: edited GH-${options.number}`);
  return 0;
}
