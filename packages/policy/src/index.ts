/**
 * Tool policy engine — TypeScript port of scripts/tool-policy.sh.
 *
 * Enforces which subcommands are allowed based on:
 *   - tool: git, gh, wt, bd, prx, slack
 *   - state: planning, validating, merging
 *   - role: planner, executor, reviewer, tester
 */

export type PolicyTool = "git" | "gh" | "wt" | "bd" | "prx" | "slack";
export type PolicyState = "planning" | "validating" | "merging";
// GH-2348.3: `keeper` is the git-write / ref-custody role (the actor that owns
// push + branch ops). It holds the same git-write capability as `executor` at
// validating/merging; it exists as a distinct role so the capability lives in
// one place (the keeper actor) rather than scattered across executor sessions.
// prx-gr1: `forge` is the gh-write / GitHub-custody role — the twin of `keeper`
// (git). It owns ALL GitHub writes (issues, labels, comments, PRs, merges) so
// the capability lives in one actor rather than scattered across executor /
// reviewer / publisher sessions; other actors dispatch gh to it.
export type PolicyRole = "planner" | "executor" | "reviewer" | "tester" | "keeper" | "forge";

export type PolicyDecision = {
  allowed: boolean;
  tool: PolicyTool;
  subcommand: string;
  state: PolicyState;
  role: PolicyRole;
};

// Static allow-lists keyed by "tool:state:role" → allowed subcommands.
//
// GH-1516 invariant: subcommand strings must never be English prepositions /
// conjunctions / copulas (`as`, `is`, `to`, `for`, `with`, etc.). Such tokens
// would defeat the layered defense in `STOP_VERB_TOKENS` (see
// src/plan/preflight_extract.ts), where the planner-side preflight drops
// matches whose second-token is a known stop-word *before* consulting this
// table. Tests pin `KNOWN_SUBCOMMANDS[tool] ∩ STOP_VERB_TOKENS === ∅`.
const POLICY_TABLE: Record<string, readonly string[]> = {
  // git
  "git:planning:planner": ["status", "diff", "log", "show", "rev-parse", "branch"],
  "git:planning:reviewer": ["status", "diff", "log", "show", "rev-parse", "branch"],
  "git:planning:tester": ["status", "diff", "log", "show", "rev-parse", "branch"],
  "git:planning:executor": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
  ],
  "git:validating:planner": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:validating:reviewer": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:validating:tester": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:validating:executor": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
    "add",
    "commit",
    "restore",
    "switch",
    "checkout",
    "merge",
    "pull",
    "push",
  ],
  "git:merging:planner": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:merging:reviewer": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:merging:tester": ["status", "diff", "log", "show", "rev-parse", "branch", "fetch"],
  "git:merging:executor": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
    "add",
    "commit",
    "restore",
    "switch",
    "checkout",
    "merge",
    "pull",
    "push",
  ],
  // GH-2348.3: keeper (git-write / ref custody) — reads everywhere; the full
  // write set (incl. push/branch) at validating + merging, mirroring executor.
  // Does not write during planning. GH-2381 admits the object-graph writers
  // write-tree/commit-tree to keeper ONLY (the sole git-writer, I-AUD4): the
  // submit artifact is identified by a tree SHA keeper materializes, and the
  // publishable commit is `commit-tree`'d from it. No other role gets them.
  // GH-201: `bundle` (local commit-range export for keeperd's host→VM object
  // ship) joins keeper's read-side caps — read-only + local, no ref mutation.
  "git:planning:keeper": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
    "bundle",
  ],
  "git:validating:keeper": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
    "bundle",
    "add",
    "commit",
    "restore",
    "switch",
    "checkout",
    "merge",
    "pull",
    "push",
    "write-tree",
    "commit-tree",
  ],
  "git:merging:keeper": [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "branch",
    "worktree",
    "fetch",
    "bundle",
    "add",
    "commit",
    "restore",
    "switch",
    "checkout",
    "merge",
    "pull",
    "push",
    "write-tree",
    "commit-tree",
  ],

  // gh (all scoped to `pr` group — the group check is in the gh tool layer)
  "gh:planning:planner": ["status", "list", "view", "checks", "diff"],
  "gh:planning:reviewer": ["status", "list", "view", "checks", "diff"],
  "gh:planning:tester": ["status", "list", "view", "checks", "diff"],
  "gh:planning:executor": ["status", "list", "view", "checks", "diff", "comment", "create", "edit"],
  "gh:validating:planner": ["status", "list", "view", "checks", "diff"],
  "gh:validating:executor": [
    "status",
    "list",
    "view",
    "checks",
    "diff",
    "comment",
    "create",
    "edit",
  ],
  "gh:validating:tester": ["status", "list", "view", "checks", "diff", "comment"],
  "gh:validating:reviewer": ["status", "list", "view", "checks", "diff", "review"],
  "gh:merging:planner": ["status", "list", "view", "checks", "diff", "review"],
  "gh:merging:tester": ["status", "list", "view", "checks", "diff", "review"],
  "gh:merging:reviewer": ["status", "list", "view", "checks", "diff", "review"],
  "gh:merging:executor": ["status", "list", "view", "checks", "diff", "comment", "create", "edit"],
  // prx-gr1: forge (gh-write / GitHub custody) — reads everywhere; the FULL gh
  // write set (issue + pr writes, review, merge/ready) at every state, mirroring
  // keeper for git. forge is the single owner of GitHub side effects; other
  // actors dispatch gh to it. The migration (removing gh-writes from the other
  // roles + the non-forge-gh architecture guard) is the rest of prx-gr1.
  "gh:planning:forge": [
    "status",
    "list",
    "view",
    "checks",
    "diff",
    "comment",
    "create",
    "edit",
    "review",
    "merge",
    "ready",
  ],
  "gh:validating:forge": [
    "status",
    "list",
    "view",
    "checks",
    "diff",
    "comment",
    "create",
    "edit",
    "review",
    "merge",
    "ready",
  ],
  "gh:merging:forge": [
    "status",
    "list",
    "view",
    "checks",
    "diff",
    "comment",
    "create",
    "edit",
    "review",
    "merge",
    "ready",
  ],

  // wt
  "wt:planning:planner": ["list", "status", "switch"],
  "wt:planning:executor": ["list", "status", "switch"],
  "wt:planning:reviewer": ["list", "status", "switch"],
  "wt:planning:tester": ["list", "status", "switch"],
  "wt:validating:planner": ["list", "status", "switch"],
  "wt:validating:executor": ["list", "status", "switch"],
  "wt:validating:reviewer": ["list", "status", "switch"],
  "wt:validating:tester": ["list", "status", "switch"],
  "wt:merging:planner": ["list", "status", "switch"],
  "wt:merging:executor": ["list", "status", "switch"],
  "wt:merging:reviewer": ["list", "status", "switch"],
  "wt:merging:tester": ["list", "status", "switch"],

  // bd — GH-1003 added recall/remember/memories.
  //
  // - recall + memories are reads → allowed for all roles, same shape as
  //   list/show/view.
  // - remember is a write → planner-only, mirroring create/update/claim/
  //   reopen. This means a plan-profile session running with
  //   PRX_AGENT_ROLE=planner can call `prx tools bd exec --subcommand
  //   remember`, which is broader than just the intake wrapper. That is the
  //   same trust posture already granted for bd update/create — operator
  //   memories are no more privileged than issue writes — so the surface
  //   is intentionally consistent rather than narrowed to intake.
  // GH-1351: `dep` (typed dep edges, e.g. parent-child / blocks) is a planner
  // write — same trust class as create/update — added so
  // `prx triage promote-children` can wire manifest-declared dep edges in
  // process. Read-side bd dep queries for executor/reviewer/tester roles still
  // route through `bd ready`/`bd list`; we don't widen reads here.
  // GH-1573: `sql` is read-only by construction (the bd wrapper injects
  // `--readonly` for this subcommand in src/tools/bd.ts), so it sits in the
  // same trust class as `list`/`show`/`view`. Routed through the planner row
  // because the only in-tree caller is `prx triage status`, which already
  // runs as planner/planning.
  // GH-1513: `admin` is admitted planner-only and gated to `admin compact` at
  // the wrapper layer in src/tools/bd.ts (per-arg check on `args[0]`). The
  // sibling `admin cleanup` / `admin reset` shapes are blocked there. The
  // only in-tree caller is `prx memory compact`, which runs as planner.
  "bd:planning:planner": [
    "ready",
    "list",
    "show",
    "view",
    "create",
    "update",
    "claim",
    "reopen",
    "assign",
    "recall",
    "remember",
    "memories",
    "dep",
    "sql",
    "admin",
  ],
  "bd:planning:executor": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:planning:reviewer": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:planning:tester": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:validating:planner": [
    "ready",
    "list",
    "show",
    "view",
    "create",
    "update",
    "claim",
    "reopen",
    "assign",
    "recall",
    "remember",
    "memories",
    "dep",
    "sql",
    "admin",
  ],
  "bd:validating:executor": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:validating:reviewer": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:validating:tester": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:merging:planner": [
    "ready",
    "list",
    "show",
    "view",
    "create",
    "update",
    "claim",
    "reopen",
    "assign",
    "recall",
    "remember",
    "memories",
    "dep",
    "sql",
    "admin",
  ],
  "bd:merging:executor": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:merging:reviewer": ["ready", "list", "show", "view", "recall", "memories"],
  "bd:merging:tester": ["ready", "list", "show", "view", "recall", "memories"],

  // slack — epic prx-zes. A READ-ONLY surface: the only subcommands are the four
  // bounded read ops (conversations.list / .history / .replies / users). All four
  // are pure reads, so they're granted to every base role at every state, same
  // trust class as bd's `list`/`show` reads. Every Slack *write* verb is
  // hard-blocked below (BLOCKED.slack) — defense in depth alongside the wrapper's
  // own SLACK_READ_OPS allowlist. keeper/forge (git/gh custody) have no slack rows
  // → no slack access, which is correct: they own ref/GitHub writes, not chat reads.
  "slack:planning:planner": ["channels", "history", "thread", "users"],
  "slack:planning:executor": ["channels", "history", "thread", "users"],
  "slack:planning:reviewer": ["channels", "history", "thread", "users"],
  "slack:planning:tester": ["channels", "history", "thread", "users"],
  "slack:validating:planner": ["channels", "history", "thread", "users"],
  "slack:validating:executor": ["channels", "history", "thread", "users"],
  "slack:validating:reviewer": ["channels", "history", "thread", "users"],
  "slack:validating:tester": ["channels", "history", "thread", "users"],
  "slack:merging:planner": ["channels", "history", "thread", "users"],
  "slack:merging:executor": ["channels", "history", "thread", "users"],
  "slack:merging:reviewer": ["channels", "history", "thread", "users"],
  "slack:merging:tester": ["channels", "history", "thread", "users"],
};

/** Hard-blocked subcommands (never allowed regardless of state/role). */
const BLOCKED: Record<PolicyTool, readonly string[]> = {
  git: ["reset", "clean", "rebase", "cherry-pick", "config", "clone", "init", "remote", "gc"],
  gh: ["close", "reopen"],
  wt: [],
  bd: ["close", "delete", "archive", "import", "export"],
  prx: [],
  // slack is a READ-ONLY surface (epic prx-zes): every write verb is hard-blocked,
  // independent of state/role, alongside the wrapper's own read-op allowlist.
  slack: [
    "post",
    "send",
    "update",
    "delete",
    "invite",
    "kick",
    "archive",
    "create",
    "join",
    "leave",
    "upload",
    "react",
    "pin",
    "unpin",
    "schedule",
    "rename",
    "set",
  ],
};

export function isBlocked(tool: PolicyTool, subcommand: string): boolean {
  return (BLOCKED[tool] ?? []).includes(subcommand);
}

// GH-1832: per-tool vocabulary set — every subcommand that appears in any
// (state, role) allowlist OR in BLOCKED. The planner-side preflight uses this
// at extraction time to drop phantom verbs (noun-as-verb prose like "bd
// records", "gh issues", "git commits") before they ever reach feasibility
// classification. Computed eagerly at module load; the surface is small and
// fixed.
const KNOWN_SUBCOMMANDS: Record<PolicyTool, Set<string>> = (() => {
  const acc: Record<PolicyTool, Set<string>> = {
    git: new Set(),
    gh: new Set(),
    wt: new Set(),
    bd: new Set(),
    prx: new Set(),
    slack: new Set(),
  };
  for (const [key, subs] of Object.entries(POLICY_TABLE)) {
    const tool = key.split(":", 1)[0] as PolicyTool;
    if (acc[tool]) {
      for (const sub of subs) acc[tool].add(sub);
    }
  }
  for (const [tool, subs] of Object.entries(BLOCKED) as [PolicyTool, readonly string[]][]) {
    for (const sub of subs) acc[tool].add(sub);
  }
  return acc;
})();

export function isKnownSubcommand(tool: PolicyTool, subcommand: string): boolean {
  return KNOWN_SUBCOMMANDS[tool]?.has(subcommand) ?? false;
}

export const POLICY_TOOLS: readonly PolicyTool[] = ["git", "gh", "wt", "bd", "prx", "slack"];

// prx-g88.1: the canonical role + state vocabularies, exported so generators
// (e.g. the actor sub-agent codegen) and `findOwningRoles` iterate ONE list
// rather than re-typing the tuple. Order is stable (used in generated output).
export const POLICY_ROLES: readonly PolicyRole[] = [
  "planner",
  "executor",
  "reviewer",
  "tester",
  "keeper",
  "forge",
];

export const POLICY_STATES: readonly PolicyState[] = ["planning", "validating", "merging"];

export function isPolicyTool(value: string): value is PolicyTool {
  return (POLICY_TOOLS as readonly string[]).includes(value);
}

// GH — read-vs-mutate classification. Conservatively lists only subcommands
// that are *unconditional* reads (pure regardless of flags) — the safe basis
// for caching their results (see @bounded-systems/proc's cachingProcExecutor). A
// subcommand that can mutate under some flag (git branch -D, gh issue edit) is
// deliberately absent: under-classifying as non-read only costs a cache miss,
// over-classifying would cache a side effect.
const READ_ONLY: Record<PolicyTool, ReadonlySet<string>> = {
  git: new Set([
    "rev-parse",
    "status",
    "log",
    "show",
    "diff",
    "ls-files",
    "ls-tree",
    "cat-file",
    "for-each-ref",
    "merge-base",
    "describe",
    "symbolic-ref",
    "rev-list",
    "show-ref",
    "name-rev",
    "var",
  ]),
  gh: new Set(["view", "list", "checks", "status"]),
  bd: new Set(["list", "show", "view", "ready", "memories", "recall", "dep", "sql"]),
  wt: new Set(["list", "status"]),
  prx: new Set<string>(),
  // slack: the whole surface is read-only — all four ops are unconditional reads.
  slack: new Set(["channels", "history", "thread", "users"]),
};

/** True iff this subcommand is an unconditional read for the tool (cacheable). */
export function isReadOnly(tool: PolicyTool, subcommand: string): boolean {
  return READ_ONLY[tool]?.has(subcommand) ?? false;
}

export function checkPolicy(
  tool: PolicyTool,
  subcommand: string,
  state: PolicyState,
  role: PolicyRole,
): PolicyDecision {
  if (isBlocked(tool, subcommand)) {
    return { allowed: false, tool, subcommand, state, role };
  }

  const key = `${tool}:${state}:${role}`;
  const allowList = POLICY_TABLE[key];
  const allowed = allowList ? allowList.includes(subcommand) : false;
  return { allowed, tool, subcommand, state, role };
}

// GH-1239: refusal-symmetry predicate shared by `prx plan preflight`
// (axis-2 allowlist-feasibility) and the in-session policy gate. Both sites
// must answer the same question — "would this action shape be allowed inside
// an executor session?" — so they consume one source of truth.
//
// `reason` is `null` when feasible. Otherwise it names which layer refused so
// the planner-side preflight can distinguish a hard block from a state/role
// allowlist miss.
export type FeasibilityReason = "blocked" | "not-allowlisted-for-role" | "unknown-tool";

export type FeasibilityResult =
  | { feasible: true; reason: null }
  | { feasible: false; reason: FeasibilityReason };

export function isFeasibleForRole(
  tool: PolicyTool,
  subcommand: string,
  state: PolicyState,
  role: PolicyRole,
): FeasibilityResult {
  if (isBlocked(tool, subcommand)) {
    return { feasible: false, reason: "blocked" };
  }
  const key = `${tool}:${state}:${role}`;
  const allowList = POLICY_TABLE[key];
  if (!allowList) {
    return { feasible: false, reason: "unknown-tool" };
  }
  if (!allowList.includes(subcommand)) {
    return { feasible: false, reason: "not-allowlisted-for-role" };
  }
  return { feasible: true, reason: null };
}

// GH-1579: which roles own this action shape at this state? Returns an empty
// array when the subcommand is hard-blocked OR universally absent from every
// (state,role) allowlist. The preflight uses this to demote a refusal that
// would otherwise read as "executor cannot run X" to a deferred finding
// pointing at the owning role/profile.
export function findOwningRoles(
  tool: PolicyTool,
  subcommand: string,
  state: PolicyState,
): PolicyRole[] {
  if (isBlocked(tool, subcommand)) return [];
  const roles: PolicyRole[] = [];
  for (const role of POLICY_ROLES) {
    const allow = POLICY_TABLE[`${tool}:${state}:${role}`];
    if (allow?.includes(subcommand)) roles.push(role);
  }
  return roles;
}

// prx-g88.1: projection of the policy table for code generators. Returns the
// sorted union, across all states, of subcommands a role may run for a tool —
// the "what can this role touch" view the actor sub-agent docs render. Reads the
// table directly so the generated allowlists cannot drift from enforcement.
export function allowedSubcommands(tool: PolicyTool, role: PolicyRole): string[] {
  const acc = new Set<string>();
  for (const state of POLICY_STATES) {
    for (const sub of POLICY_TABLE[`${tool}:${state}:${role}`] ?? []) acc.add(sub);
  }
  return [...acc].sort();
}

/** prx-g88.1: the hard-blocked subcommands for a tool (never allowed, any role). */
export function blockedSubcommands(tool: PolicyTool): readonly string[] {
  return BLOCKED[tool] ?? [];
}

// The single owner-of-effect projection. A role OWNS a (tool, subcommand) when
// it may run it in *some* state; hard-blocked subcommands are owned by no one.
// Both halves of the capability model read THIS function so they cannot
// disagree: the production-time guard surface (the capability-ownership
// `.feature`, via `agents/capability_feature.ts`) and the after-the-fact
// verify gate (`provenance/effect-ownership.ts`). Equivalent to "∃ state:
// subcommand ∈ findOwningRoles(tool, subcommand, state)", computed once.
export function ownersOf(tool: PolicyTool, subcommand: string): PolicyRole[] {
  if (isBlocked(tool, subcommand)) return [];
  return POLICY_ROLES.filter((role) => allowedSubcommands(tool, role).includes(subcommand));
}

// GH-1397: `checkPolicy` sibling that enqueues a structured handoff when the
// deny would otherwise read as "executor cannot run X, but role <X> can".
//
// Returns the same `PolicyDecision` as `checkPolicy` plus, when an enqueue
// fires, the resulting `handoffId`. Callers that adopt this sibling get the
// queue path for free; the original `checkPolicy` stays untouched so the
// existing in-tree call sites are not forced to migrate.
//
// `enqueue` is injected to keep this module free of the bd / CAS / audit
// graph. Wire it at the boundary (`src/handoff/from-deny.ts:checkPolicyOrEnqueueDefault`).
export type CheckPolicyOrEnqueueResult = PolicyDecision & {
  handoffId?: string;
  /** Why no handoff was enqueued — present on `allowed: false` rows that did
   *  not enqueue (no owning role, enqueue disabled, bd unprovisioned, …). */
  enqueueSkipped?:
    | "no-owning-role"
    | "enqueue-disabled"
    | "bd-unprovisioned"
    | "cross-repo"
    | "error";
};

export type CheckPolicyOrEnqueueDeps = {
  /** Owns the bd+CAS write. See `src/handoff/from-deny.ts`. */
  enqueue?: (input: {
    tool: PolicyTool;
    subcommand: string;
    state: PolicyState;
    role: PolicyRole;
    owningRoles: PolicyRole[];
  }) => Promise<
    | { kind: "enqueued"; handoffId: string }
    | { kind: "skipped"; reason: "bd-unprovisioned" | "cross-repo" | "error" }
  >;
};

export async function checkPolicyOrEnqueue(
  tool: PolicyTool,
  subcommand: string,
  state: PolicyState,
  role: PolicyRole,
  deps: CheckPolicyOrEnqueueDeps = {},
): Promise<CheckPolicyOrEnqueueResult> {
  const decision = checkPolicy(tool, subcommand, state, role);
  if (decision.allowed) return decision;
  if (isBlocked(tool, subcommand)) {
    // Hard-blocked verbs do not enqueue — no role can run them, so the queue
    // would have no recipient. `enqueueSkipped: "no-owning-role"` is the
    // honest signal.
    return { ...decision, enqueueSkipped: "no-owning-role" };
  }
  const owningRoles = findOwningRoles(tool, subcommand, state);
  if (owningRoles.length === 0) {
    return { ...decision, enqueueSkipped: "no-owning-role" };
  }
  if (!deps.enqueue) {
    return { ...decision, enqueueSkipped: "enqueue-disabled" };
  }
  const r = await deps.enqueue({ tool, subcommand, state, role, owningRoles });
  if (r.kind === "enqueued") {
    return { ...decision, handoffId: r.handoffId };
  }
  return { ...decision, enqueueSkipped: r.reason };
}

export function phaseToState(phase: string): PolicyState {
  switch (phase) {
    case "ready_to_merge":
      return "merging";
    case "in_review":
    case "waiting_on_ci":
    case "changes_requested":
    case "blocked":
      return "validating";
    default:
      return "planning";
  }
}

export function formatPolicyDecision(decision: PolicyDecision, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(decision, null, 2);
  }
  const verdict = decision.allowed ? "allow" : "deny";
  return `${decision.tool}-safe: ${verdict} '${decision.subcommand}' for state '${decision.state}' role '${decision.role}'`;
}
