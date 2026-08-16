// GH-1397 — translate the two deny seams into structured handoffs.
//
// Both seams converge on `enqueueHandoff` (src/handoff/store.ts):
//
//   1. Policy-table denies (src/tools/policy.ts:checkPolicyOrEnqueue) — the
//      caller passes a `{tool, subcommand, state, role, owningRoles}` shape;
//      this module turns it into a `HandoffEnvelope` and routes it.
//
//   2. Flag-layer denies — the `disallowedTools` rejection seam. The agent
//      detects a harness-side deny and calls `enqueueFromFlagLayerDeny`
//      directly. There is no in-process rejection-detection point today;
//      this seam ships as a typed entry point that the eventual harness
//      hook (or `prx handoff enqueue` operator wrapper) will call.
//
// Owning-role mapping: each policy `(tool, subcommand)` pair maps to one
// recipient actor. The mapping is intentionally narrow — `git push` →
// publisher; `bd remember` → triage; `gh pr edit` → author. Unknown pairs
// fall through to `publisher` because the publisher actor (GH-1564) is
// the documented primary recipient (GH-1398 ADR §5).

import { getEnv } from "@bounded-systems/env";
import { hostName } from "@bounded-systems/host";

import type {
  HandoffEnvelope,
  HandoffTargetActor,
  WorkUnitId,
} from "@bounded-systems/machine-schema";

import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import type {
  PolicyRole,
  PolicyState,
  PolicyTool,
  CheckPolicyOrEnqueueDeps,
} from "@bounded-systems/policy";

// ── handoff-queue seam (formerly src/handoff/store.ts) ─────────────────────
//
// GH-1012: the handoff queue was persisted through bd memory (Dolt-backed).
// With bd removed the persistence backend is gone, so there is no store to
// enqueue into. These type shapes and the `enqueueHandoff` entry point are
// retained locally so the deny → handoff translation logic below still
// type-checks and `cli.ts` keeps its import; the enqueue itself is now a
// no-op that reports the queue as unavailable (mapped to a "skipped" result).

export type HandoffStoreDeps = {
  /** Override for tests that want to bypass real CAS writes. */
  casWriteBlob?: ((content: string, domain: string) => Promise<{ sha: string }>) | undefined;
  now?: (() => Date) | undefined;
  /** `repoNameWithOwner(cwd)` for the cross-repo guard. */
  currentRepoSlug?: (() => string) | undefined;
};

export type EnqueueResult =
  | { kind: "created"; envelope: HandoffEnvelope }
  | { kind: "duplicate"; envelope: HandoffEnvelope; existingId: string }
  | { kind: "bd-unprovisioned"; error: string }
  | { kind: "cross-repo-refused"; expected: string; got: string };

export type EnqueueInput = Omit<
  HandoffEnvelope,
  "id" | "dedupKey" | "enqueuedAt" | "status" | "attempts" | "inputRefs" | "maxAttempts"
> & {
  /** Optional caller-supplied inputRefs; CAS spillover handles get appended. */
  inputRefs?: string[];
  /** Defaults to 3 (envelope schema default). */
  maxAttempts?: number;
};

/**
 * Enqueue a handoff. The persistent queue was bd-backed and removed in
 * GH-1012, so this now returns a "queue unavailable" result rather than
 * writing a row. The cross-repo guard is preserved for callers that still
 * inject `currentRepoSlug`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function enqueueHandoff(
  input: EnqueueInput,
  deps: HandoffStoreDeps = {},
): Promise<EnqueueResult> {
  if (deps.currentRepoSlug) {
    const expected = deps.currentRepoSlug();
    if (expected && input.repoSlug !== expected) {
      return { kind: "cross-repo-refused", expected, got: input.repoSlug };
    }
  }
  return {
    kind: "bd-unprovisioned",
    error: "handoff queue removed (GH-1012): no persistent backend to enqueue into",
  };
}

// ── owning-role → recipient mapping ────────────────────────────────────────

/**
 * Map a denied `(tool, subcommand)` pair to the recipient actor that owns it.
 * The mapping mirrors GH-1398 ADR §3:
 *
 *   git  push / branch / fetch / commit  → keeper     (GH-2348.3 git-write role)
 *   gh   pr.* / issue.close              → publisher  (GH-1558 forge surface)
 *   gh   pr edit body                    → author     (GH-1206 author actor)
 *   bd   remember / create / update      → triage     (GH-1397 triage analog)
 *
 * Default fallback is `publisher` (the documented primary forge recipient,
 * GH-1398 ADR §5).
 */
export function recipientForDeniedVerb(tool: PolicyTool, subcommand: string): HandoffTargetActor {
  if (tool === "bd") {
    // Triage owns bd writes (promote, prioritize, remember, …).
    return "triage";
  }
  if (tool === "gh" && subcommand === "edit") {
    // gh pr edit is the author actor's body-apply surface.
    return "author";
  }
  if (tool === "git") {
    // GH-2348.3: git-write (push/branch/commit/merge) is the keeper's domain.
    return "keeper";
  }
  // gh forge (pr.*), wt, and the rest → publisher.
  return "publisher";
}

// ── policy-table deny → enqueue ────────────────────────────────────────────

export type EnqueueFromPolicyDenyDeps = HandoffStoreDeps & {
  /** Current session id (for audit-side cross-ref). */
  sessionId?: () => string | undefined;
  /** Originating actor name. Defaults to the live env's PRX role mapping. */
  sourceActor?: () => string;
  /** Current work unit id (e.g. "GH-1397"). */
  workUnitId?: () => WorkUnitId | null;
  /** Current worktree path/branch — populated when the source session has one. */
  workTreeRef?: () => { path: string; branch: string } | undefined;
  /** Repo slug ("OWNER/REPO"). */
  repoSlug?: () => string;
};

/**
 * Default `CheckPolicyOrEnqueueDeps.enqueue` adapter. Build it once at the
 * call site (so all deps inject cleanly) and pass to `checkPolicyOrEnqueue`.
 */
export function buildPolicyEnqueueAdapter(
  deps: EnqueueFromPolicyDenyDeps = {},
): NonNullable<CheckPolicyOrEnqueueDeps["enqueue"]> {
  return async ({ tool, subcommand, state, role, owningRoles }) => {
    const target = recipientForDeniedVerb(tool, subcommand);
    const repoSlug =
      deps.repoSlug?.() ?? tryRepoSlug(defaultRepoNameWithOwner) ?? hostName() ?? "unknown-repo";
    const result = await enqueueHandoff(
      buildEnvelopeInput({
        target,
        repoSlug,
        sourceActor: deps.sourceActor?.() ?? sourceActorFromEnv(),
        sourceSessionId: deps.sessionId?.(),
        workUnitId: deps.workUnitId?.() ?? null,
        workTreeRef: deps.workTreeRef?.(),
        intent: {
          verb: `${tool}.${subcommand}`,
          args: { tool, subcommand, state, role, owningRoles },
        },
        denialReason: "not-allowlisted-for-role",
        policyKey: { tool, subcommand, state, role },
      }),
      deps,
    );
    return mapEnqueueResult(result);
  };
}

// ── flag-layer deny → enqueue ──────────────────────────────────────────────

/**
 * Build a structured handoff for the `disallowedTools` seam. Called when
 * the claude harness denies a tool call inside an open session; the agent
 * (or a future harness hook) invokes this so the deny becomes a typed,
 * routable handoff instead of an opaque deny message.
 *
 * `tool` here is the harness tool name (`"Edit"`, `"Bash(git push:*)"`, …),
 * not the policy table's `(tool, subcommand)` shape — the flag-layer is
 * coarser. `target` defaults to `publisher` per the GH-1398 ADR §5
 * primary-recipient rule; callers that know the target override it.
 */
export async function enqueueFromFlagLayerDeny(
  input: {
    tool: string;
    args?: unknown;
    target?: HandoffTargetActor | undefined;
    workUnitId?: WorkUnitId | null | undefined;
    repoSlug?: string | undefined;
    sourceActor?: string | undefined;
    sourceSessionId?: string | undefined;
    workTreeRef?: { path: string; branch: string } | undefined;
  },
  deps: HandoffStoreDeps = {},
): Promise<EnqueueResult> {
  const repoSlug = input.repoSlug ?? tryRepoSlug(defaultRepoNameWithOwner) ?? "unknown-repo";
  const target = input.target ?? "publisher";
  return enqueueHandoff(
    buildEnvelopeInput({
      target,
      repoSlug,
      sourceActor: input.sourceActor ?? sourceActorFromEnv(),
      sourceSessionId: input.sourceSessionId,
      workUnitId: input.workUnitId ?? null,
      workTreeRef: input.workTreeRef,
      intent: { verb: input.tool, args: input.args ?? null },
      denialReason: "flag-layer-deny",
    }),
    deps,
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildEnvelopeInput(input: {
  target: HandoffTargetActor;
  repoSlug: string;
  sourceActor: string;
  sourceSessionId: string | undefined;
  workUnitId: WorkUnitId | null;
  workTreeRef: { path: string; branch: string } | undefined;
  intent: { verb: string; args: unknown };
  denialReason: "blocked" | "not-allowlisted-for-role" | "unknown-tool" | "flag-layer-deny";
  policyKey?: {
    tool: string;
    subcommand: string;
    state: string;
    role: string;
  };
}): EnqueueInput {
  return {
    workUnitId: input.workUnitId,
    repoSlug: input.repoSlug,
    sourceActor: input.sourceActor,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    targetActor: input.target,
    intent: input.intent,
    denialReason: input.denialReason,
    ...(input.policyKey ? { policyKey: input.policyKey } : {}),
    ...(input.workTreeRef ? { workTreeRef: input.workTreeRef } : {}),
    maxAttempts: 3,
  };
}

function mapEnqueueResult(
  r: EnqueueResult,
):
  | { kind: "enqueued"; handoffId: string }
  | { kind: "skipped"; reason: "bd-unprovisioned" | "cross-repo" | "error" } {
  switch (r.kind) {
    case "created":
      return { kind: "enqueued", handoffId: r.envelope.id };
    case "duplicate":
      return { kind: "enqueued", handoffId: r.existingId };
    case "bd-unprovisioned":
      return { kind: "skipped", reason: "bd-unprovisioned" };
    case "cross-repo-refused":
      return { kind: "skipped", reason: "cross-repo" };
  }
}

function sourceActorFromEnv(): string {
  const role = getEnv("PRX_AGENT_ROLE");
  if (typeof role === "string" && role.length > 0) return role;
  return "executor";
}

function tryRepoSlug(fn: (cwd: string) => string): string | undefined {
  try {
    const slug = fn(process.cwd());
    if (typeof slug === "string" && slug.length > 0) return slug;
  } catch {
    // ignored — caller falls through to hostname/unknown
  }
  return undefined;
}

// Re-export `PolicyTool` / `PolicyRole` / `PolicyState` to keep call sites
// from importing them through two paths.
export type { PolicyRole, PolicyState, PolicyTool };
