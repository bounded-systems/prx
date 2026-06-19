import { workUnitSources, type ResolvedWorkUnit } from "../pr-state/resolvers/types.ts";

/**
 * Canonical semantics for `prx session open` / session entry, aligned with the workflow lifecycle machine
 * (`src/machine/state.ts`, parity chain, phase model). User-facing help and CLI errors should
 * import from here so wording stays consistent.
 */

/** One-line definition: what “open” opens in PRX. */
export const PRX_SESSION_OPEN_DEFINITION =
  "Open the PRX session for a work unit: hydrate linked workflow state from the lifecycle machine (issue, beads, parity chain, branch/worktree, PR, CI), derive legal next actions, and prepare the surface for the CLI, TUI, or an optional agent.";

/** The work unit id is the lookup key; the session is the runtime object being opened. */
export const PRX_SESSION_IDENTIFIER_VS_OBJECT =
  "The canonical id (for example GH-321) identifies the work unit; the opened object is the local PRX session for that unit — not the issue row, branch, or PR alone.";

/** Clarifies what `open` does *not* mean (avoids the vague “open a thing” reading). */
export const PRX_SESSION_OPEN_IS_NOT =
  "Not limited to: opening a single file, a branch alone, a PR alone, or launching an agent alone — those are projections the session resolves together.";

/** One-line definition: what `prx plan session` does. GH-1982: the alias `prx session plan` routes through the same handler. */
export const PRX_SESSION_PLAN_DEFINITION =
  "Draft a read-only Claude plan for a work unit: hydrate workflow state, inject the planner machine-first prompt, and run Claude in `--permission-mode plan`. Default is non-interactive (`--print`) — the plan is emitted to stdout and auto-saved to the `<UoW>:plan@draft` CAS slot that `prx implement` consumes. Pass `--interactive` to open a live plan-mode session instead.";

export function formatPrxSessionOpenHelpBlock(): string[] {
  return [
    "PRX session (`prx session open`; transitional: `prx open`, bare `prx session <id>`):",
    `  ${PRX_SESSION_OPEN_DEFINITION}`,
    `  ${PRX_SESSION_IDENTIFIER_VS_OBJECT}`,
    `  ${PRX_SESSION_OPEN_IS_NOT}`,
    "",
  ];
}

/** Prefix for user-facing errors when session entry is blocked (after the colon, add the reason). */
export function prxSessionCannotOpenPrefix(workUnitId: string): string {
  return `Cannot open PRX session for ${workUnitId}:`;
}

export function prxSessionBoardReadFailureMessage(workUnitId: string, details: string): string {
  return [
    `Failed to read remote board status while preparing to open PRX session for ${workUnitId}.`,
    "This can happen due to transient GitHub authentication or API failures.",
    "Run `prx chain status --remote` to inspect chain status and `gh auth status` to verify GitHub authentication.",
    `Underlying error: ${details}`,
  ].join(" ");
}

function describeResolvedWorkUnit(resolved: ResolvedWorkUnit): string {
  const title = resolved.title.trim().length > 0 ? resolved.title : resolved.id;
  return resolved.url ? `${JSON.stringify(title)} (${resolved.url})` : JSON.stringify(title);
}

/**
 * GH-799: session entry hit a non-GH canonical id but prx.toml doesn't
 * register an issue-authority resolver for that id pattern. Tells the
 * operator how to configure one or fall back to GH-<n>.
 * GH-1421: identity overlays now use [sources.<name>] (kind = "github" |
 * "notion" | "beads") instead of the legacy [identity] / [identity.notion]
 * shape.
 */
export function prxSessionNoSourceConfiguredMessage(workUnitId: string): string {
  return [
    `${prxSessionCannotOpenPrefix(workUnitId)} no issue-authority resolver is configured for this canonical id.`,
    'Register a [sources.<name>] block (kind = "github" | "notion" | "beads") in prx.toml, or use a GH-<n> id.',
  ].join(" ");
}

/**
 * GH-799: session entry called the configured resolver (Notion, etc.) and it
 * threw. Surface the underlying error and point at `prx check-issue` for a
 * direct retry without going through session entry.
 */
export function prxSessionSourceNotFoundMessage(
  workUnitId: string,
  sourceLabel: string,
  details: string,
): string {
  return [
    `${prxSessionCannotOpenPrefix(workUnitId)} ${sourceLabel} lookup failed: ${details}.`,
    `Verify the id exists in ${sourceLabel} and that credentials are configured (run \`prx check-issue ${workUnitId}\` to retry the lookup directly).`,
  ].join(" ");
}

/**
 * GH-799: the configured resolver returned a ticket in a closed state.
 * Parallels the GH-closed wording in checkWorkUnitChain; reopen rather than
 * materialize, so we deliberately do NOT suggest `--create --from=<source>`.
 */
export function prxSessionSourceClosedMessage(
  workUnitId: string,
  resolved: ResolvedWorkUnit,
): string {
  return [
    `${prxSessionCannotOpenPrefix(workUnitId)} ${resolved.source} page ${describeResolvedWorkUnit(resolved)} is closed, so issue authority is not active.`,
    `Reopen in ${resolved.source} or choose a different work unit.`,
  ].join(" ");
}

/**
 * GH-799: the resolver confirmed the ticket exists and is open, but no local
 * parity-chain unit has been projected yet. Signposts toward the
 * `--create --from=<source>` flag (GH-870) which validates the resolver-
 * backed source and materializes the worktree in one step.
 */
export function prxSessionNotProjectedLocallyMessage(
  workUnitId: string,
  resolved: ResolvedWorkUnit,
): string {
  // GH-2089: only suggest `--from=<source>` when the CLI actually accepts that
  // flag value (i.e. the source is in `workUnitSources`). The prior text
  // emitted `--from=beads` before the CLI implemented the verb, leaving the
  // operator following a hint that flat-out failed at the flag layer.
  const sourceIsAccepted = (workUnitSources as readonly string[]).includes(resolved.source);
  // `--create` already auto-resolves the source from the resolver, so the
  // redundant `--from=<source>` is dropped. Point at the canonical
  // `prx plan session` (interactive) / `prx plan agent` (headless) entry — not
  // the retired `prx session open` alias. The `sourceIsAccepted` gate (GH-2089)
  // still suppresses the hint when the resolver's source isn't a `--create`
  // target.
  const materializeHint = sourceIsAccepted
    ? `, or \`prx plan session ${workUnitId} --create\` (interactive) / \`prx plan agent ${workUnitId} --create\` (headless) to materialize it locally`
    : "";
  return [
    `${prxSessionCannotOpenPrefix(workUnitId)} ${resolved.source} page ${describeResolvedWorkUnit(resolved)} exists but has no local parity-chain unit yet.`,
    `Run \`prx chain backfill --authority issue --scope all\`${materializeHint}.`,
  ].join(" ");
}

/**
 * GH-2067: structured `--format json` envelope paired with
 * [[prxSessionNotProjectedLocallyMessage]]. The plain-text message stays the
 * source of truth for prose; this builder fills the typed fields a JSON
 * consumer (canonical=bd hydration smoke, automated retry branches) needs to
 * branch on the error code without parsing free text. The
 * `suggestedNextCommands` array honours the same `workUnitSources` gate as
 * the text helper — the materialize hint is omitted when the resolver's
 * source is not yet wired into the `--from=<source>` flag (GH-2089
 * invariant).
 */
export type PrxSessionNotProjectedLocallyDetails = {
  code: "PRX_SESSION_NOT_PROJECTED_LOCALLY";
  message: string;
  workUnitId: string;
  source: string;
  title: string;
  url: string | null;
  suggestedNextCommands: string[];
};

export function prxSessionNotProjectedLocallyEnvelope(
  workUnitId: string,
  resolved: ResolvedWorkUnit,
): PrxSessionNotProjectedLocallyDetails {
  const sourceIsAccepted = (workUnitSources as readonly string[]).includes(resolved.source);
  const suggestedNextCommands = ["prx chain backfill --authority issue --scope all"];
  if (sourceIsAccepted) {
    // `--create` auto-resolves the source; point at the canonical plan entry
    // (not the retired `prx session open` alias). The headless `prx plan agent
    // <id> --create` is the pipeline-flow form; the interactive twin is
    // `prx plan session <id> --create`.
    suggestedNextCommands.push(`prx plan agent ${workUnitId} --create`);
  }
  return {
    code: "PRX_SESSION_NOT_PROJECTED_LOCALLY",
    message: prxSessionNotProjectedLocallyMessage(workUnitId, resolved),
    workUnitId,
    source: resolved.source,
    title: resolved.title,
    url: resolved.url,
    suggestedNextCommands,
  };
}

/**
 * GH-914: parity-cleanup remediation. Splits suggestions by whether any
 * of the prune actions target a teammate-authored remote branch — in
 * that case `prx chain prune --authority issue --scope all` is the wrong
 * remediation because it would push a destructive remote delete against
 * a branch the operator does not own. The split is opaque to the verb
 * caller; pass `foreignBranches` for the subset of prune-action branches
 * whose HEAD author is positively *not* the operator.
 */
export function prxSessionParityCleanupMessage(
  workUnitId: string,
  pruneActions: string[],
  foreignBranches: string[] = [],
): string {
  const prefix = `${prxSessionCannotOpenPrefix(workUnitId)} parity-chain cleanup is required first (${pruneActions.join(", ")}).`;
  if (foreignBranches.length === 0) {
    return [prefix, "Run `prx chain prune --authority issue --scope all` and retry."].join(" ");
  }
  const sample = foreignBranches.slice(0, 3).join(", ");
  const more = foreignBranches.length > 3 ? `, … (${foreignBranches.length} total)` : "";
  return [
    prefix,
    `Cleanup includes branches authored by other operators (${sample}${more}); \`prx chain prune\` would push destructive deletes against work you do not own.`,
    "Pick a different local branch name (`--branch <name>`) or coordinate with the branch author before retrying.",
  ].join(" ");
}

/**
 * GH-924: session entry hit a work unit whose lifecycle is already terminal —
 * PR merged or closed, or the GitHub/Beads issue is completed. The worktree
 * is still on disk, so the parity chain didn't emit a `delete_local_branch`
 * action and `checkWorkUnitChain`'s prune gate let it through; without this
 * message the operator would land on a tmux pane that silently exits. Surface
 * the lifecycle artifacts and signpost the next-step verbs (`prx prune`,
 * `prx delegate next`) instead.
 */
export type PrxSessionUnitCompleteContext = {
  prMergeState?: "merged" | "closed" | null;
  ghIssueClosed?: boolean;
  beadsIssueClosed?: boolean;
  worktreePath?: string | null;
};

export function prxSessionUnitCompleteMessage(
  workUnitId: string,
  context: PrxSessionUnitCompleteContext,
): string {
  const reasons: string[] = [];
  if (context.prMergeState === "merged") reasons.push("PR merged");
  if (context.prMergeState === "closed") reasons.push("PR closed");
  if (context.ghIssueClosed) reasons.push("GitHub issue closed");
  if (context.beadsIssueClosed) reasons.push("Beads issue closed");
  const reasonClause = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  const worktreeClause = context.worktreePath ? ` Worktree at ${context.worktreePath}.` : "";
  return [
    `${prxSessionCannotOpenPrefix(workUnitId)} work unit is complete${reasonClause}.${worktreeClause}`,
    `Try: \`prx prune --ticket ${workUnitId}\` to tear down, or \`prx delegate next\` to pick the next ready unit.`,
  ].join(" ");
}

/**
 * GH-935: refusal hint when `prx session open <id>` resolves to a GH issue
 * carrying `type::epic`. Each child must ship as its own PR per the project's
 * "Independent PR — no bundled or speculative changes" norm, so the verb exits
 * non-zero and lists the children sourced from beads parent-child edges
 * (GH-891 epic content layer is authoritative for containment).
 *
 * `children` is the empty array when no parent-child edges are registered in
 * beads — the message still refuses, with a hint that either the edges are
 * missing or the `type::epic` label is stale.
 */
export type EpicChildSummary = {
  ghNumber: number;
  title: string;
  state: "open" | "closed";
};

export function prxSessionEpicRefusalMessage(
  workUnitId: string,
  children: readonly EpicChildSummary[],
): string {
  const lines: string[] = [];
  lines.push(
    `${prxSessionCannotOpenPrefix(workUnitId)} ${workUnitId} is an epic (type::epic). Epics are not valid PR targets — each child ships independently.`,
  );
  if (children.length === 0) {
    lines.push(
      "  No children are registered in beads via parent-child edges. Either add children with `bd dep add --type=parent-child <child> <epic>`, or remove the `type::epic` label from this issue if it isn't actually an epic.",
    );
    return lines.join("\n");
  }
  lines.push("Open a child instead:");
  for (const child of children) {
    const truncated = child.title.length > 64 ? `${child.title.slice(0, 61)}...` : child.title;
    lines.push(`  - GH-${child.ghNumber} (${truncated}) [${child.state}]`);
  }
  return lines.join("\n");
}

export const PRX_SESSION_DEPRECATION_WORK =
  "Warning: `prx work` is deprecated; use `prx session open` (or transitional `prx open` / `prx session <id>`).";

export const PRX_SESSION_OPEN_REQUIRES_TARGET =
  "prx session open requires a canonical issue-backed work unit id, or a canonical worktree directory name (for example GH-5195).";

/**
 * GH-977: deprecation hint emitted when the operator types `prx session open`
 * (now an alias) instead of the canonical `prx plan session`. The alias-vs-
 * canonical equivalence lives in the session-entry XState machine
 * (`src/machine/machines/session-entry.ts`) — this constant is the single
 * source of truth for the hint text, ready to be sourced via the help-surface
 * registry's `Deprecation.stderr_hint` field once GH-974 Child 1 lands.
 */
export const PRX_SESSION_OPEN_ALIAS_HINT =
  "`prx session open` is an alias for `prx plan session`. Prefer the canonical form.";

/**
 * GH-1982: deprecation hint emitted when the operator types `prx session plan`
 * (now an alias) instead of the canonical `prx plan session`. Mirrors
 * [[PRX_SESSION_OPEN_ALIAS_HINT]]. The alias path also sets
 * `invokedViaPlanSession: true` so the auto-save chain into the
 * `<UoW>:plan@draft` CAS slot (see [[PRX_SESSION_PLAN_DEFINITION]]) fires for
 * the alias too — closing the silent footgun that previously left the draft
 * slot empty and broke the `prx implement` handoff.
 */
export const PRX_SESSION_PLAN_ALIAS_HINT =
  "`prx session plan` is an alias for `prx plan session`. Prefer the canonical form.";
