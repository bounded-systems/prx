export const toolActors = [
  "git",
  "wt",
  "gh",
  "doctor",
  "publisher",
  "keeper",
  "prx",
  "local_ci",
  "remote_ci",
  "notion_mcp",
  // ai-home-0kyti: OAuth-backed Notion CLI actor — wraps the `notion-cli`
  // binary (hosted-MCP/OAuth substrate) for headless work-unit resolution
  // (search + page view). Peer to `beads` (kind:cli); distinct from
  // `notion_mcp` (kind:mcp_server, interactive). Owns the read path the
  // NotionCliResolver drives.
  "notion_cli",
  "beads",
  "llm_agent",
  "planner_agent",
  "executor_agent",
  "tester_agent",
  "reviewer_agent",
  "tmux",
  "dep_research",
  "domain_sync",
  // GH-1245: 2-day spike for the external→substrate refresh chokepoint
  // (docs/fetch-actor-spike.md). v0 verb is `fetch gh-issues --dry-run`;
  // no transitions guard on the events in the spike — the actor is
  // documentary so the post-spike write ticket can wire events to
  // phase transitions without churning the catalog twice.
  "fetch",
  // GH-1659: cross-repo routing planning actor. Detects foreign
  // bd-workspace prefixes in `BD-<prefix>-<tail>` surface ids, resolves
  // them through `.prx/repos/index.json`, materializes the target bare,
  // and re-dispatches `OPEN_PLAN_SESSION` against the foreign bd
  // workspace. Lifecycle mirrors `fetch` byte-for-byte; ADR:
  // docs/spikes/GH-1646-cross-repo-bd-routing.md §5.
  "repo_router",
  // GH-1768: Datalog-as-derived-truth spike. Read-only Horn-clause
  // evaluator over projected facts; emits three observability events
  // (DERIVE_FACTS_PROJECTED, DERIVE_QUERY_RUN, DERIVE_TRACE_EMITTED)
  // and no mutating verbs. Stays in the catalog only for the spike
  // window; retire if the retro recommends discard.
  "derive",
  // GH-1978: workspace lifecycle actor. Owns the
  // reserved → prepared → ready ⇄ running → torn_down graph for a
  // worktree-on-disk. Drivers (worktrunk today; devcontainer / nix
  // devShell / CI pre-job tomorrow) call into it through the
  // `prx workspace <verb>` CLI without leaking driver vocabulary
  // into the contract. Retires wtctl's sync / ignore sync / up / down
  // surface.
  "workspace",
  // GH-2009: dolt lifecycle actor. Owns the
  // provisioned → running ⇄ healthy → stopped → orphaned graph for a
  // per-repo dolt sql-server. Drivers (hydrate, sync-all, provision,
  // auto-push policy, launchd supervisor, start/stop/status/adopt)
  // call into it via the `prx dolt <verb>` CLI without leaking driver
  // vocabulary. Replaces the GH-555 `prx tools dolt` proposal
  // (incompatible with GH-1934's `prx tools` retirement). Driver
  // tickets re-shape under this contract: GH-555 (start/stop/status/
  // adopt), GH-557 (install + DSN handoff via `start` output), GH-568
  // (`supervise`, launchd plist on Darwin), GH-1685 (`provision`),
  // GH-1702 (`sync-all`, kept on its current shape per GH-2009 frame),
  // GH-1938 (`policy dolt.auto-push`), GH-826 mirror follow-ups
  // (`DOLT_MIRROR_REFRESHED`).
  "dolt",
  // GH-1495: temporal→durable memory digest. The per-run lifecycle
  // (resolving → loading → parsing → extracting → writing → completed |
  // no_new_memories | failed_<stage>) is driven by
  // `transcriptsDigestMachine` (src/transcripts-digest/machine.ts). v0
  // ships three source adapters (claude-code-jsonl, claude-web-export) and
  // three writer modes (--dry-run, --stage, --commit). Standalone routine
  // like `dep_research` / `domain_sync` — not part of the per-work-unit
  // `prSystem` graph.
  "transcripts_digest",
  // GH-2027: session-open lifecycle actor. Routes the six
  // `prx <actor> session` verbs (plan, implement, intake, triage,
  // submit, author) through the `workspace.reserve` → `workspace.prepare`
  // → `sessionEntryMachine` dispatch chain so each verb spawns into
  // its own worktree instead of inheriting the operator's mainx cwd.
  // Wiring, not new machinery — composes existing `workspace`
  // primitives. Invariants I-SO1..I-SO3 (see `src/machine/state.ts`).
  "session_open",
  // prx-wt5: merge-conflict reconciliation actor — design pass. A
  // *mediator* (facilitates, never imposes): when main advances under an
  // open work-unit branch, the branch must rebase onto the moved base
  // before submit. The mediator detects an in-progress rebase/merge,
  // classifies each conflicted path (content / add-add / delete-modify;
  // ours=HEAD/base vs theirs=incoming), and models the
  // detecting → conflicted → resolving → resolved → reconciled lifecycle
  // (mediatorMachine, src/machine/machines/mediator.ts). v0 is documentary:
  // it writes NOTHING to the working tree (I-MED1) — resolution edits stay
  // with the operator, and the `git rebase --continue/--abort` EFFECTS stay
  // owned by `git`/`keeper` (I-MED4, the same intent⟂effect split as
  // keeper⟂git); the mediator emits the `RECONCILE_CONTINUE_REQUESTED`
  // intent only. Its terminal `reconciled` state hands off to
  // `prx submit stage` re-resolution (`RESTAGE_REQUESTED`) so the rebased
  // tree flows through `publish`. The impose/auto-resolve variant
  // (LLM proposes + applies hunks) is a future `arbiter` sibling. Detector
  // orchestrator, restage wiring, and `arbiter` land in child tickets.
  "mediator",
  // GH-188: observability actor. Owns the telemetry domain — the pilot/fleet
  // legs DELEGATE emission to it (they don't own telemetry), and it exports the
  // leg-event stream (OTel spans/metrics/log events, NATS #258) to a collector.
  // Concrete backend today: Jaeger (OTLP). Like `derive`, it emits observability
  // events and mutates nothing in the work tree; optional signed `observed@<unit>`
  // attestation makes telemetry a verifiable effect in the in-toto chain. The
  // operator's framing: "Jaeger should become an actor too."
  "telemetry",
] as const;

export type ToolActor = (typeof toolActors)[number];
export type ActorScope = "pr" | "workflow";

export type ToolActorSpec = {
  actor: ToolActor;
  // `observability` (GH-188) is the telemetry tier — the actor observes the
  // pipeline rather than planning/executing/publishing it. `tier` is consumed
  // only for display (`prx model actors`), so this is an additive value.
  tier: "planning" | "execution" | "verification_publication" | "observability";
  kind: "cli" | "api_cli" | "local_runner" | "external_runner" | "mcp_server" | "agent";
  domain: string;
  emits: string[];
  accepts: string[];
  implementations?: string[];
};

export const toolActorCatalog: Record<ToolActor, ToolActorSpec> = {
  git: {
    actor: "git",
    tier: "execution",
    kind: "cli",
    domain: "source_control",
    // GH-2381: `write-tree`/`commit-tree` are object-graph writes; `git` owns
    // their effect facts (TREE_WRITTEN, COMMIT_MATERIALIZED) — keeper owns the
    // intents, preserving the existing intent ⟂ effect split.
    emits: ["BRANCH_CREATED", "REMOTE_BRANCH_PUBLISHED", "PUSH_COMMIT", "BRANCH_DELETED", "BRANCH_REFRESHED", "TREE_WRITTEN", "COMMIT_MATERIALIZED"],
    accepts: ["commit", "push", "rebase", "fetch", "add", "write-tree", "commit-tree"],
  },
  wt: {
    actor: "wt",
    tier: "execution",
    kind: "cli",
    domain: "workspace",
    emits: ["WORKTREE_CREATED", "WORKTREE_REMOVED", "WORKTREE_PRUNED", "WORKTREE_DIRTY", "BARE_MATERIALIZED"],
    accepts: ["add", "switch", "prune", "list", "materialize"],
  },
  gh: {
    actor: "gh",
    tier: "verification_publication",
    kind: "api_cli",
    domain: "pull_requests",
    emits: [
      "PR_OPENED",
      "PR_CONVERTED_TO_DRAFT",
      "PR_READY_FOR_REVIEW",
      "PR_CLOSED",
      "PR_MERGED",
      "REVIEW_REQUESTED",
      "REVIEW_APPROVED",
      "CHANGES_REQUESTED",
      "MERGEABILITY_UPDATED",
    ],
    accepts: ["pr.create", "pr.ready", "pr.review", "pr.merge", "pr.view", "pr.list"],
  },
  // GH-885 + GH-882: PR readiness diagnostician. Reads PR state via gh and
  // requests guarded transitions (ready/draft/automerge) through gh's GraphQL
  // surface. The first verification_publication-tier actor that both reads
  // from and writes through gh.
  doctor: {
    actor: "doctor",
    tier: "verification_publication",
    kind: "cli",
    domain: "pull_request_readiness",
    emits: [
      "PR_INVENTORY_READ",
    ],
    accepts: ["pr.inventory", "pr.ready", "pr.draft", "pr.merge"],
  },
  // GH-1558, narrowed by GH-2348.3: `publisher` is the FORGE role — PR
  // open/update/merge/ready/draft + issue-close/update, fanning to the `gh`
  // tool. The git-write intents (push, branch ops) moved to `keeper`
  // (GH-2348.3) so the intent layer mirrors the `git` ⟂ `gh` effect split;
  // this deliberately amends GH-1398's original "single home for git-write"
  // framing. GH-2382 added `issue.update` / `ISSUE_UPDATE_REQUESTED`: the
  // bd→GH issue *edit* intent (the lossless title/body/label reconcile), the
  // sibling of `issue.close` / `ISSUE_CLOSE_REQUESTED`. Owns intents only —
  // effect facts stay on `gh` (PR_OPENED, PR_MERGED, MERGEABILITY_UPDATED, …).
  publisher: {
    actor: "publisher",
    tier: "verification_publication",
    kind: "cli",
    domain: "publication",
    emits: [
      "PR_OPEN_REQUESTED",
      "PR_UPDATE_REQUESTED",
      // ai-home-2ow2v: forge comment/edit verbs (gh pr comment / gh pr edit).
      "PR_COMMENT_REQUESTED",
      "PR_EDIT_REQUESTED",
      "ISSUE_CLOSE_REQUESTED",
      "ISSUE_UPDATE_REQUESTED",
      "PR_AUTOMERGE_REQUESTED",
      "PR_READY_REQUESTED",
      "PR_DRAFT_REQUESTED",
      "AUTOMERGE_ENABLED",
      "AUTOMERGE_DISABLED",
    ],
    accepts: [
      "pr.open",
      "pr.update",
      // ai-home-2ow2v: forge comment/edit verbs.
      "pr.comment",
      "pr.edit",
      "pr.merge",
      "pr.ready",
      "pr.draft",
      "issue.close",
      "issue.update",
    ],
  },
  // GH-2348.3: `keeper` is the GIT-WRITE / ref-custody role — push and branch
  // ops, plus GH-2381's commit-materialization (write-tree at stage,
  // commit-tree at publish) — fanning to the `git` tool. Split out of
  // `publisher` so one role maps to one tool boundary. Its authority is custody
  // of the ref/object graph (the capability-gated sole git-writer, I-AUD4), NOT
  // code judgment — verdicts stay with tester/reviewer. Owns intents only —
  // effect facts stay on `git` (PUSH_COMMIT, BRANCH_*, TREE_WRITTEN,
  // COMMIT_MATERIALIZED).
  keeper: {
    actor: "keeper",
    tier: "verification_publication",
    kind: "cli",
    domain: "ref_custody",
    emits: [
      "PUSH_REQUESTED",
      "BRANCH_OP_REQUESTED",
      "TREE_MATERIALIZE_REQUESTED",
      "COMMIT_MATERIALIZE_REQUESTED",
    ],
    accepts: ["push", "branch", "write-tree", "commit-tree"],
  },
  prx: {
    actor: "prx",
    tier: "planning",
    kind: "cli",
    domain: "workflow_control",
    emits: [
      "WORKFLOW_STATE_READ",
      "WORKFLOW_ACTIONS_READ",
      "WORKFLOW_TRANSITION_REQUESTED",
      // GH-1510: multi-thread next-work selection. `NEXT_WORK_PROJECTED`
      // marks a full picker run; `NEXT_WORK_THREAD_RANKED` is per-thread so
      // operators can see why a thread sits where it does in the ordering.
      "NEXT_WORK_PROJECTED",
      "NEXT_WORK_THREAD_RANKED",
      // GH-1397: handoff-queue lifecycle. Plumbing under every actor — when
      // a harness-denied verb is detected, the originating actor emits
      // HANDOFF_ENQUEUED with a structured envelope for the recipient
      // actor (publisher / triage / submit / author) to drain. The
      // remaining four events bracket the drain lifecycle. All ride
      // `appendAuditRow` and carry `uow_id` (I-HQ1, grounds I-AUD1).
      "HANDOFF_ENQUEUED",
      "HANDOFF_CLAIMED",
      "HANDOFF_DRAINED",
      "HANDOFF_FAILED",
      "HANDOFF_ABANDONED",
    ],
    accepts: [
      "status",
      "snapshot",
      "actions",
      "phase",
      "board",
      "transition",
      "event",
      "runtime-profile",
      "dispatch",
      // GH-1510: portfolio-wide picker. The single-pick `nextWorktree()`
      // ranker (and its prior `prx worktree next` surface) collapsed
      // into this multi-thread surface; GH-983 added the filter-aware
      // `prx delegate next` sibling on top of the same projection.
      "next_work",
      // GH-1397: handoff-queue verbs. `enqueue` / `claim` / `drain` /
      // `status` / `replay` drive the structured handoff queue for
      // harness-denied verbs; the generic drain harness ships with a
      // single `noop` recipient adapter (real adapters land in their
      // own tickets — GH-1564 for publisher, etc.).
      "handoff.enqueue",
      "handoff.claim",
      "handoff.drain",
      "handoff.status",
      "handoff.replay",
    ],
  },
  local_ci: {
    actor: "local_ci",
    tier: "verification_publication",
    kind: "local_runner",
    domain: "validation",
    emits: ["LOCAL_CI_STARTED", "LOCAL_CI_PASSED", "LOCAL_CI_FAILED"],
    accepts: ["run", "rerun", "cancel"],
  },
  remote_ci: {
    actor: "remote_ci",
    tier: "verification_publication",
    kind: "external_runner",
    domain: "validation",
    emits: ["REMOTE_CI_QUEUED", "REMOTE_CI_STARTED", "REMOTE_CI_PASSED", "REMOTE_CI_FAILED"],
    accepts: [],
  },
  notion_mcp: {
    actor: "notion_mcp",
    tier: "planning",
    kind: "mcp_server",
    domain: "planning_docs",
    emits: ["NOTION_PAGE_READ", "NOTION_PAGE_UPDATED", "NOTION_DB_QUERY"],
    accepts: ["read", "write", "search"],
  },
  // ai-home-0kyti: headless OAuth Notion resolution actor. Wraps `notion-cli`
  // (search + page view) — the substrate the NotionCliResolver drives for
  // exact PROJ-/PROD- resolution over OAuth. Read-only (no write/UPDATED
  // events): unlike notion_mcp it does not mutate pages.
  notion_cli: {
    actor: "notion_cli",
    tier: "planning",
    kind: "cli",
    domain: "planning_docs",
    emits: ["NOTION_PAGE_READ", "NOTION_DB_QUERY"],
    accepts: ["read", "search"],
  },
  beads: {
    actor: "beads",
    tier: "planning",
    kind: "cli",
    domain: "task_graph",
    emits: [
      "TASK_CREATED",
      "TASK_UPDATED",
      "TASK_CLAIMED",
      "TASK_READY",
      "DEPENDENCY_ADDED",
      "DEPENDENCY_REMOVED",
      "BD_SCHEMA_DRIFT_DETECTED",
      "BD_SCHEMA_REPAIRED",
      // GH-1510: bd-ready + dep-graph read surface. `BD_READY_QUERIED`
      // marks every live `bd ready --json` call; the cache-* events expose
      // staleness to the operator without forcing a re-query.
      "BD_READY_QUERIED",
      "BD_GRAPH_READ",
      "BD_READY_CACHE_HIT",
      "BD_READY_CACHE_REFRESHED",
      "BD_READY_CACHE_STALE_SERVED",
      // GH-1706: per-step events emitted by `prx beads migrate` as it walks
      // a registered, embedded-mode workspace through the destructive
      // `bd init --reinit-local` into shared-server mode. Documentary —
      // no machine transitions consume them; they exist so the operator
      // can inspect the daily audit NDJSON and confirm where a migration
      // stopped (e.g. on `BD_MIGRATION_FAILED` the backup-dir lives next
      // to the row's `details.backupDir`).
      "BD_MIGRATION_STARTED",
      "BD_MIGRATION_BACKUP_WRITTEN",
      "BD_MIGRATION_REINIT_COMPLETED",
      "BD_MIGRATION_METADATA_PATCHED",
      "BD_MIGRATION_VERIFIED",
      "BD_MIGRATION_COMPLETED",
      "BD_MIGRATION_FAILED",
      // GH-1750: per-step events emitted by `prx repo bootstrap` (verb owner
      // GH-1704) as it drives `bd init` through a HOME-isolated subprocess.
      // Parallel to the BD_MIGRATION_* family — same actor (`beads`), same
      // documentary role (no machine transitions consume them; operator can
      // audit the NDJSON to see whether the legacy `${HOME}/.local/share/
      // beads-home/embeddeddolt/` workaround was load-bearing on a given run).
      "BD_BOOTSTRAP_STARTED",
      "BD_BOOTSTRAP_LEGACY_HOME_DETECTED",
      "BD_BOOTSTRAP_LEGACY_HOME_ISOLATED",
      "BD_BOOTSTRAP_INIT_COMPLETED",
      "BD_BOOTSTRAP_INDEX_UPDATED",
      "BD_BOOTSTRAP_COMPLETED",
      "BD_BOOTSTRAP_FAILED",
    ],
    accepts: [
      "create",
      "update",
      "claim",
      "close",
      "dep.add",
      "dep.remove",
      "ready",
      "repair",
      // GH-1510: typed read of dep edges (parent-child, blocks, relates_to,
      // duplicates, supersedes, replies_to) — used by the next-work picker
      // to filter blocked-by-open items out of the ready_to_start thread.
      "graph",
      // GH-1706: embedded → shared-server migration verb (`prx beads migrate`).
      "migrate",
    ],
  },
  llm_agent: {
    actor: "llm_agent",
    tier: "execution",
    kind: "agent",
    domain: "text_and_code_generation",
    // GH-1828: `claude_sdk` is the non-interactive Anthropic Agent SDK
    // implementation; `claude_code` stays for interactive CLI subprocesses.
    // Migration boundary is per-call-site (spike §3.2), not per-actor.
    implementations: ["claude_code", "claude_sdk", "codex", "gemini_cli"],
    emits: ["TEXT_PROPOSED", "CODE_PROPOSED", "PLAN_PROPOSED", "PATCH_PROPOSED"],
    accepts: ["prompt", "revise", "apply_if_permitted"],
  },
  planner_agent: {
    actor: "planner_agent",
    tier: "planning",
    kind: "agent",
    domain: "task_scoping",
    // GH-1828: SDK-backed non-interactive planner runs (plan-print) via
    // `claude_sdk`; interactive plan-session resumes via `claude_code`.
    implementations: ["claude_code", "claude_sdk", "codex", "gemini_cli"],
    emits: ["ROLE_PLANNER_STARTED", "ROLE_PLANNER_COMPLETED", "ROLE_PLANNER_FAILED", "TASK_SCOPE_CONFIRMED"],
    accepts: ["plan", "scope", "confirm_success_criteria"],
  },
  executor_agent: {
    actor: "executor_agent",
    tier: "execution",
    kind: "agent",
    domain: "bounded_code_change",
    implementations: ["claude_code", "codex", "gemini_cli"],
    emits: ["ROLE_EXECUTOR_STARTED", "ROLE_EXECUTOR_COMPLETED", "ROLE_EXECUTOR_FAILED", "PATCH_PROPOSED"],
    accepts: ["implement", "revise"],
  },
  tester_agent: {
    actor: "tester_agent",
    tier: "verification_publication",
    kind: "agent",
    domain: "test_validation",
    implementations: ["claude_code", "codex", "gemini_cli"],
    emits: ["ROLE_TESTER_STARTED", "ROLE_TESTER_COMPLETED", "ROLE_TESTER_FAILED"],
    accepts: ["run_tests", "diagnose_failures"],
  },
  reviewer_agent: {
    actor: "reviewer_agent",
    tier: "verification_publication",
    kind: "agent",
    domain: "review_validation",
    implementations: ["claude_code", "codex", "gemini_cli"],
    emits: ["ROLE_REVIEWER_STARTED", "ROLE_REVIEWER_COMPLETED", "ROLE_REVIEWER_FAILED"],
    accepts: ["review", "approve_or_reject"],
  },
  tmux: {
    actor: "tmux",
    tier: "execution",
    kind: "cli",
    domain: "terminal_multiplexer",
    emits: [
      "TMUX_OPTION_SHOWN",
      "TMUX_OPTION_SET",
      "TMUX_RECONCILE_STARTED",
      "TMUX_RECONCILE_COMPLETED",
      "TMUX_RECONCILE_DRIFT_WARNED",
    ],
    accepts: ["show", "set", "list-sessions", "has-session"],
  },
  // GH-1275 (PR-3 of GH-1261): the per-run dep-research lifecycle. Drives
  // fetch → snapshot → diff → classify on a single dep entry; PR-4 extends
  // the `reporting` terminal state to invoke the GH-issue filing actor.
  dep_research: {
    actor: "dep_research",
    tier: "planning",
    kind: "cli",
    domain: "dep_drift_detection",
    emits: [
      "DEP_RESEARCH_REQUESTED",
      "DEP_FETCH_COMPLETED",
      "DEP_SNAPSHOT_WRITTEN",
      "DEP_DIFF_COMPUTED",
      "DEP_DELTA_CLASSIFIED",
      "DEP_RESEARCH_NO_DELTA",
    ],
    accepts: ["research", "manifest", "status"],
  },
  // GH-1537 (GH-1500 authority ADR §3a): the periodic beads↔external-mirror
  // reconcile job. One budget-gated tick over the *known pinned* `(uow,
  // domain)` pairs (`prx beads sync`); each pair runs through the per-pair
  // `domainSyncMachine` (src/sync/machine.ts). Standalone routine, like
  // `dep_research` — not part of the per-work-unit `prSystem` graph.
  domain_sync: {
    actor: "domain_sync",
    tier: "planning",
    kind: "cli",
    domain: "external_mirror_sync",
    emits: [
      "DOMAIN_SYNC_PAIR_STARTED",
      "DOMAIN_SYNC_PULLED",
      "DOMAIN_SYNC_PUSHED",
      "DOMAIN_SYNC_PAIR_DONE",
      "DOMAIN_SYNC_PAIR_FAILED",
      "DOMAIN_SYNC_BUDGET_PAUSED",
      "DOMAIN_SYNC_TICK_COMPLETED",
      // GH-1662: cross-repo daemon (`prx beads sync --all-repos`) per-repo
      // lifecycle. Emitted by `runBeadsSyncAcrossRepos` (src/sync/run-cross-repo.ts);
      // one bracket per indexed repo, plus _SKIPPED when materialize fails.
      "DOMAIN_SYNC_REPO_STARTED",
      "DOMAIN_SYNC_REPO_COMPLETED",
      "DOMAIN_SYNC_REPO_SKIPPED",
    ],
    accepts: ["sync"],
  },
  // GH-1245 (spike, docs/fetch-actor-spike.md): the external→substrate
  // refresh chokepoint. GH-1603 opens the write path — the v0 trio of
  // "documentary" events stays, augmented with six new ones that drive
  // `fetchMachine` (src/machine/machines/fetch.ts):
  //   FETCH_PAGE_FETCHED          — graphql page response parsed cleanly
  //   FETCH_PAGE_WRITTEN          — per-page bd write loop committed all rows
  //   FETCH_PAGE_FAILED           — graphql or bd write failed
  //   FETCH_WATERMARK_ADVANCED    — setWatermark succeeded after a page write
  //   FETCH_RUN_COMPLETED         — last page committed + no more pages
  //   FETCH_RUN_FAILED_MID_FETCH  — aborted with ≥1 successful page committed
  fetch: {
    actor: "fetch",
    tier: "planning",
    kind: "cli",
    domain: "external_substrate_refresh",
    emits: [
      "FETCH_PLAN_COMPUTED",
      "FETCH_WATERMARK_READ",
      "FETCH_DRY_RUN_DECIDED",
      "FETCH_PAGE_FETCHED",
      "FETCH_PAGE_WRITTEN",
      "FETCH_PAGE_FAILED",
      "FETCH_WATERMARK_ADVANCED",
      "FETCH_RUN_COMPLETED",
      "FETCH_RUN_FAILED_MID_FETCH",
    ],
    accepts: ["gh-issues"],
  },
  // GH-1659: cross-repo routing actor. Drives the `repoRouterMachine`
  // (src/machine/machines/repo_router.ts). Library entry point lives at
  // `src/repo_router/index.ts`; CLI wiring (`--repo` flag, OPEN_PLAN_SESSION
  // re-dispatch) is GH-1661.
  //
  // `BARE_MATERIALIZED` is owned by `wt` (GH-1660 / #1676 — the
  // materialize verb shares wt's surface). The router *consumes* that
  // event on the `materializing → routed` edge; it does not emit it.
  repo_router: {
    actor: "repo_router",
    tier: "planning",
    kind: "cli",
    domain: "cross_repo_routing",
    emits: [
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "SESSION_RE_DISPATCHED",
      "ROUTE_REFUSED_NO_PIN",
      "ROUTE_REFUSED_CONFLICT",
      "ROUTE_FAILED",
    ],
    accepts: ["route"],
  },
  // GH-1768: derived-truth spike. Three observability events; no
  // `accepts` because every verb is read-only. The actor never
  // requests a workflow transition; it only reports what the rules
  // derived from the existing projections.
  derive: {
    actor: "derive",
    tier: "planning",
    kind: "cli",
    domain: "derived_truth",
    emits: [
      "DERIVE_FACTS_PROJECTED",
      "DERIVE_QUERY_RUN",
      "DERIVE_TRACE_EMITTED",
    ],
    accepts: [],
  },
  // GH-1978: workspace lifecycle actor. Lifecycle states
  // reserved → prepared → ready ⇄ running → torn_down (see
  // workspaceMachine in src/machine/machines/workspace.ts). The
  // `prx workspace <verb>` CLI is the only entry point — drivers
  // (worktrunk today, devcontainer/nix devShell/CI pre-job tomorrow)
  // call into it via that surface. Replaces wtctl's
  // sync / ignore sync / up / down surface (GH-1978; supersedes
  // GH-550's "install wtctl as a declared dependency" counter).
  workspace: {
    actor: "workspace",
    tier: "execution",
    kind: "cli",
    domain: "workspace_lifecycle",
    emits: [
      "WORKSPACE_RESERVED",
      "WORKSPACE_MATERIALIZED",
      "WORKSPACE_PREPARED",
      "WORKSPACE_SYNCED",
      "WORKSPACE_SERVICES_STARTED",
      "WORKSPACE_SERVICES_STOPPED",
      "WORKSPACE_TORN_DOWN",
      "WORKSPACE_OP_FAILED",
    ],
    accepts: ["reserve", "materialize", "prepare", "sync", "service", "teardown"],
  },
  // GH-2009: dolt lifecycle actor — design pass. Catalog entry only;
  // the runtime (`src/dolt/actor.ts`), reconcile migration
  // (`src/pr-state/dolt-reconcile.ts` → `src/dolt/reconcile.ts`),
  // ledger I/O, port arbitration, launchd plist, and nix-pinned
  // install land in re-shaped child tickets (GH-555, GH-557, GH-568,
  // GH-1685, GH-1938). GH-1702 stays on its current shape per the
  // GH-2009 frame; this entry declares `sync-all` so 1702's eventual
  // landing is contract-compatible. Driver inventory:
  //   provision  GH-1685   provisioned                 (bd init + dolthub create + initial push)
  //   start      GH-555    provisioned → running       (sql-server up; emits dsn)
  //   stop       GH-555    running/healthy → stopped
  //   status     GH-555    read; emits HEALTHY/ORPHANED
  //   adopt      GH-555    external → running (prx-owned), explicit legacy import escape valve
  //   reconcile  existing  commit/pull/push pipeline (already at `prx dolt reconcile`)
  //   sync-all   GH-1702   fan-out over reconcile (kept on existing shape per GH-2009 frame)
  //   policy     GH-1938   dolt.auto-push / dolt.auto-commit (idempotent config write)
  //   supervise  GH-568    launchd hand-off (Darwin only; no-op elsewhere)
  dolt: {
    actor: "dolt",
    tier: "execution",
    kind: "cli",
    domain: "dolt_lifecycle",
    emits: [
      "DOLT_PROVISIONED",
      "DOLT_SERVER_STARTED",
      "DOLT_SERVER_HEALTHY",
      "DOLT_SERVER_STOPPED",
      "DOLT_SERVER_ORPHANED",
      "DOLT_ADOPTED",
      "DOLT_RECONCILED",
      "DOLT_RECONCILE_FAILED",
      "DOLT_MIRROR_REFRESHED",
      "DOLT_AUTO_PUSH_POLICY_SET",
      "DOLT_OP_FAILED",
      // GH-1702: `prx beads sync-all` fan-out emits. Mirror the shape of the
      // `domain_sync` actor's `DOMAIN_SYNC_REPO_*` family — one tick-bracketing
      // ALL_STARTED / ALL_COMPLETED pair, plus per-repo STARTED →
      // RECONCILED / SKIPPED / FAILED. The fan-out wraps the same per-repo
      // primitive (`runDoltReconcile`) that already emits `DOLT_RECONCILED` /
      // `DOLT_RECONCILE_FAILED`; these new events bracket the *cross-repo*
      // walk so a tick is queryable as a single unit in the audit sink.
      "DOLT_SYNC_ALL_STARTED",
      "DOLT_SYNC_REPO_STARTED",
      "DOLT_SYNC_REPO_RECONCILED",
      "DOLT_SYNC_REPO_SKIPPED",
      "DOLT_SYNC_REPO_FAILED",
      "DOLT_SYNC_ALL_COMPLETED",
    ],
    accepts: [
      "provision",
      "start",
      "stop",
      "status",
      "adopt",
      "reconcile",
      "sync-all",
      "policy",
      "supervise",
    ],
  },
  // GH-1495: temporal→durable memory digest. Producer side of the
  // architectural principle from GH-1491 — Claude Code transcripts
  // (~/.claude/projects/*.jsonl) carry a 30-day TTL, so this is the
  // chokepoint that compresses temporal artifacts into long-lived
  // deterministic memory shards before they age out. Three source
  // adapters in v0; the source-adapter registry (sources/registry.ts)
  // is the documented extension point for Codex / ChatGPT / Gemini
  // adapters in follow-up issues.
  transcripts_digest: {
    actor: "transcripts_digest",
    tier: "planning",
    kind: "cli",
    domain: "memory_distillation",
    emits: [
      "TRANSCRIPT_DIGEST_REQUESTED",
      "TRANSCRIPT_SOURCE_RESOLVED",
      "TRANSCRIPT_LOAD_COMPLETED",
      "TRANSCRIPT_PARSE_COMPLETED",
      "TRANSCRIPT_PARSE_LINE_SKIPPED",
      "TRANSCRIPT_EXTRACTION_COMPLETED",
      "TRANSCRIPT_DIGEST_STAGED",
      "TRANSCRIPT_DIGEST_COMMITTED",
      "TRANSCRIPT_DIGEST_NO_NEW_MEMORIES",
      "TRANSCRIPT_DIGEST_FAILED",
    ],
    accepts: ["digest", "status", "list-sources"],
  },
  // GH-2027: session-open lifecycle actor. Composes the existing
  // `workspace` primitives (`reserve` → `prepare`) with
  // `sessionEntryMachine` profile-build dispatch so every
  // `prx <actor> session` verb opens into its own worktree. The
  // single `accepts` entry is the verb name; per-actor selection is
  // carried on the `SessionOpenInput.actor` field. I-SO1 forbids
  // CLI handlers from dispatching `OPEN_*_SESSION` events directly.
  session_open: {
    actor: "session_open",
    tier: "planning",
    kind: "cli",
    domain: "session_lifecycle",
    emits: [
      "SESSION_OPEN_REQUESTED",
      "SESSION_OPEN_NAME_DERIVED",
      "SESSION_OPEN_RESERVED",
      "SESSION_OPEN_MATERIALIZED",
      "SESSION_OPEN_PREPARED",
      "SESSION_OPEN_DISPATCHED",
      "SESSION_OPEN_FAILED",
    ],
    accepts: ["open"],
  },
  // prx-wt5: merge-conflict reconciliation actor — design pass. Catalog
  // citizen + documentary `mediatorMachine` only; the detector orchestrator
  // (reads live `git rebase`/`merge` state), the `RESTAGE_REQUESTED` →
  // `prx submit stage` handoff, and the impose/auto-resolve `arbiter` sibling
  // land in child tickets. Verbs (`detect`/`classify`/`status`) are read-only
  // in v0 — the mediator writes nothing to the working tree (I-MED1).
  //
  // Event families:
  //   CONFLICT_DETECTED / CONFLICT_CLASSIFIED  — the dispute + its per-path shape
  //   MEDIATION_STARTED / RESOLUTION_OBSERVED   — facilitation lifecycle (observed,
  //                                               not authored — the operator edits)
  //   RECONCILE_CONTINUE_REQUESTED              — INTENT handed to git/keeper
  //                                               (effect = `git rebase --continue`); I-MED4
  //   MEDIATION_ABORTED                          — `git rebase --abort` taken (observed)
  //   RECONCILE_COMPLETED                        — clean tree, no in-progress op (I-MED3)
  //   RESTAGE_REQUESTED                          — handoff to `prx submit stage`
  // Every event carries `uow_id` (+ `branch`, `base_ref`) for I-MED2 / I-AUD1.
  mediator: {
    actor: "mediator",
    tier: "execution",
    kind: "cli",
    domain: "merge_conflict",
    emits: [
      "CONFLICT_DETECTED",
      "CONFLICT_CLASSIFIED",
      "MEDIATION_STARTED",
      "RESOLUTION_OBSERVED",
      "RECONCILE_CONTINUE_REQUESTED",
      "MEDIATION_ABORTED",
      "RECONCILE_COMPLETED",
      "RESTAGE_REQUESTED",
    ],
    accepts: ["detect", "classify", "status"],
  },
  // GH-188: the telemetry actor — owns the observability domain. The pilot/fleet
  // legs delegate emission to it; it exports the leg-event stream to a collector
  // (OTLP → Jaeger today; NATS #258 a sibling transport). Documentary like
  // `derive`: mutates nothing in the work tree. `observed@<unit>` is the optional
  // signed attestation that makes telemetry a verifiable in-toto chain effect.
  telemetry: {
    actor: "telemetry",
    tier: "observability",
    kind: "external_runner",
    domain: "observability",
    emits: ["TELEMETRY_LEG_OBSERVED", "TELEMETRY_EXPORTED", "TELEMETRY_EXPORT_FAILED"],
    accepts: ["span.emit", "metric.emit", "log.emit", "export"],
  },
};

export const actorScopes: Record<ActorScope, ToolActor[]> = {
  pr: ["git", "wt", "gh", "doctor", "keeper", "publisher", "prx", "local_ci", "remote_ci", "mediator"],
  workflow: [
    "notion_mcp",
    "beads",
    "prx",
    "llm_agent",
    "planner_agent",
    "executor_agent",
    "tester_agent",
    "reviewer_agent",
    "git",
    "wt",
    "gh",
    "doctor",
    "keeper",
    "publisher",
    "local_ci",
    "remote_ci",
    "tmux",
    "dep_research",
    "domain_sync",
    "fetch",
    "repo_router",
    "derive",
    "workspace",
    "dolt",
    "transcripts_digest",
    "session_open",
    "mediator",
    // GH-188: telemetry observes the whole workflow (pilot/fleet legs), so it is
    // a workflow-scope actor, not a per-PR-contract (`pr`) one.
    "telemetry",
  ],
};

export const eventOwnerMap: Record<string, ToolActor> = {
  // GH-188: telemetry actor's observability events.
  TELEMETRY_LEG_OBSERVED: "telemetry",
  TELEMETRY_EXPORTED: "telemetry",
  TELEMETRY_EXPORT_FAILED: "telemetry",
  BRANCH_CREATED: "git",
  REMOTE_BRANCH_PUBLISHED: "git",
  PUSH_COMMIT: "git",
  BRANCH_DELETED: "git",
  // GH-2381: object-graph materialization effect facts. Owned by `git` (the
  // effect actor); keeper owns the matching *_REQUESTED intents below.
  TREE_WRITTEN: "git",
  COMMIT_MATERIALIZED: "git",
  WORKTREE_CREATED: "wt",
  WORKTREE_REMOVED: "wt",
  WORKTREE_PRUNED: "wt",
  WORKTREE_DIRTY: "wt",
  // GH-1660: documentary event marking that a registered bare repo's working
  // copy on disk is current. Owned by `wt`; consumed by the GH-1659
  // `repo_router` machine in its `materializing → routed` edge.
  BARE_MATERIALIZED: "wt",
  PR_OPENED: "gh",
  PR_CONVERTED_TO_DRAFT: "gh",
  PR_READY_FOR_REVIEW: "gh",
  PR_CLOSED: "gh",
  PR_MERGED: "gh",
  REVIEW_REQUESTED: "gh",
  REVIEW_APPROVED: "gh",
  CHANGES_REQUESTED: "gh",
  MERGEABILITY_UPDATED: "gh",
  LOCAL_CI_STARTED: "local_ci",
  LOCAL_CI_PASSED: "local_ci",
  LOCAL_CI_FAILED: "local_ci",
  REMOTE_CI_QUEUED: "remote_ci",
  REMOTE_CI_STARTED: "remote_ci",
  REMOTE_CI_PASSED: "remote_ci",
  REMOTE_CI_FAILED: "remote_ci",
  NOTION_PAGE_UPDATED: "notion_mcp",
  TASK_CREATED: "beads",
  TASK_UPDATED: "beads",
  TASK_CLAIMED: "beads",
  TASK_READY: "beads",
  DEPENDENCY_ADDED: "beads",
  DEPENDENCY_REMOVED: "beads",
  BD_SCHEMA_DRIFT_DETECTED: "beads",
  BD_SCHEMA_REPAIRED: "beads",
  // GH-1510: bd-ready + dep-graph reads + cache events. Documentary in the
  // first cut — no machine transitions consume them; the next-work picker
  // emits them so the operator can see staleness/refresh decisions.
  BD_READY_QUERIED: "beads",
  BD_GRAPH_READ: "beads",
  BD_READY_CACHE_HIT: "beads",
  BD_READY_CACHE_REFRESHED: "beads",
  BD_READY_CACHE_STALE_SERVED: "beads",
  // GH-1706: bd embedded → shared-server migration audit trail. Owned by
  // `beads`; emitted by `runBeadsMigrate` (src/beads/migrate.ts) at every
  // checkpoint of the destructive reinit.
  BD_MIGRATION_STARTED: "beads",
  BD_MIGRATION_BACKUP_WRITTEN: "beads",
  BD_MIGRATION_REINIT_COMPLETED: "beads",
  BD_MIGRATION_METADATA_PATCHED: "beads",
  BD_MIGRATION_VERIFIED: "beads",
  BD_MIGRATION_COMPLETED: "beads",
  BD_MIGRATION_FAILED: "beads",
  // GH-1750: bootstrap-side `bd init` audit trail (verb owner GH-1704).
  // Owned by `beads`; emitted by `runRepoBootstrap` (src/pr-state/
  // repo_bootstrap.ts) around the HOME-isolated `bd init` invocation.
  BD_BOOTSTRAP_STARTED: "beads",
  BD_BOOTSTRAP_LEGACY_HOME_DETECTED: "beads",
  BD_BOOTSTRAP_LEGACY_HOME_ISOLATED: "beads",
  BD_BOOTSTRAP_INIT_COMPLETED: "beads",
  BD_BOOTSTRAP_INDEX_UPDATED: "beads",
  BD_BOOTSTRAP_COMPLETED: "beads",
  BD_BOOTSTRAP_FAILED: "beads",
  TEXT_PROPOSED: "llm_agent",
  CODE_PROPOSED: "llm_agent",
  PLAN_PROPOSED: "llm_agent",
  PATCH_PROPOSED: "llm_agent",
  ROLE_PLANNER_STARTED: "planner_agent",
  ROLE_PLANNER_COMPLETED: "planner_agent",
  ROLE_PLANNER_FAILED: "planner_agent",
  ROLE_EXECUTOR_STARTED: "executor_agent",
  ROLE_EXECUTOR_COMPLETED: "executor_agent",
  ROLE_EXECUTOR_FAILED: "executor_agent",
  ROLE_TESTER_STARTED: "tester_agent",
  ROLE_TESTER_COMPLETED: "tester_agent",
  ROLE_TESTER_FAILED: "tester_agent",
  ROLE_REVIEWER_STARTED: "reviewer_agent",
  ROLE_REVIEWER_COMPLETED: "reviewer_agent",
  ROLE_REVIEWER_FAILED: "reviewer_agent",
  TASK_SPEC_SYNCED: "prx",
  TASK_SCOPE_CONFIRMED: "planner_agent",
  TASK_SUCCESS_CRITERIA_CONFIRMED: "planner_agent",
  TMUX_OPTION_SHOWN: "tmux",
  TMUX_OPTION_SET: "tmux",
  TMUX_RECONCILE_STARTED: "tmux",
  TMUX_RECONCILE_COMPLETED: "tmux",
  TMUX_RECONCILE_DRIFT_WARNED: "tmux",

  // GH-885: doctor actor event (PR readiness diagnosis — inventory read).
  // GH-1558 (GH-1398 ADR): the request/effect events that drive PR ready/
  // draft/automerge transitions moved doctor → publisher; doctor keeps the
  // report-only inventory event.
  PR_INVENTORY_READ: "doctor",
  // GH-885 / GH-1558: doctor → publisher ownership move per GH-1398 ADR.
  // Publisher is the single home for PR-transition request intents; the
  // effect facts (PR_OPENED, PR_MERGED, …) stay owned by `gh`.
  PR_AUTOMERGE_REQUESTED: "publisher",
  PR_READY_REQUESTED: "publisher",
  PR_DRAFT_REQUESTED: "publisher",
  // GH-885 / GH-1558: phase-write event when automerge is registered with
  // GitHub. Owned by `publisher` as part of the merge-transition surface.
  AUTOMERGE_ENABLED: "publisher",
  AUTOMERGE_DISABLED: "publisher",
  // GH-1558 intent events. The forge ones stay on `publisher`; GH-2348.3
  // moved the git-write ones (PUSH_REQUESTED, BRANCH_OP_REQUESTED) to
  // `keeper`. Effect facts stay on `git`/`gh`. CLI verbs that emit these land
  // in follow-on PRs; ownership is registered here so the catalog is stable.
  PUSH_REQUESTED: "keeper",
  PR_OPEN_REQUESTED: "publisher",
  PR_UPDATE_REQUESTED: "publisher",
  PR_COMMENT_REQUESTED: "publisher",
  PR_EDIT_REQUESTED: "publisher",
  BRANCH_OP_REQUESTED: "keeper",
  // GH-2381: commit-materialization intents. Owned by `keeper` (sole
  // git-writer); the `git` effect facts are TREE_WRITTEN / COMMIT_MATERIALIZED.
  TREE_MATERIALIZE_REQUESTED: "keeper",
  COMMIT_MATERIALIZE_REQUESTED: "keeper",
  ISSUE_CLOSE_REQUESTED: "publisher",
  // GH-2382: bd→GH issue-edit intent (the lossless title/body/label reconcile).
  // Sibling of ISSUE_CLOSE_REQUESTED; emitted by `prx beads publish` on a real
  // reconcile and by the `publisher issueUpdate` verb, both fanning to the
  // narrow `gh issue edit` chokepoint (`execGhIssueEdit`).
  ISSUE_UPDATE_REQUESTED: "publisher",

  // GH-1194: per-actor dispatch envelope events. Owner = prx because the
  // dispatch envelope is workflow-control; the target actor still emits its
  // own verb-specific events captured into the CAS payload.
  DISPATCH_REQUESTED: "prx",
  DISPATCH_COMPLETED: "prx",
  DISPATCH_FAILED: "prx",

  // GH-1510: multi-thread next-work selection events. Owner = prx because
  // the picker is portfolio-level workflow control; per-thread ranking
  // exposes ordering decisions to status-line and audit surfaces.
  NEXT_WORK_PROJECTED: "prx",
  NEXT_WORK_THREAD_RANKED: "prx",

  // GH-1397: handoff-queue lifecycle. Owner = prx because the queue is
  // workflow plumbing under every actor. Every HANDOFF_* event carries
  // `uow_id` + `handoff_id` (I-HQ1, grounds I-AUD1) and rides
  // `appendAuditRow` so `v_uow_attachment_rate` and
  // `v_lineage_completeness_rate` keep their targets when handoffs
  // start emitting.
  HANDOFF_ENQUEUED: "prx",
  HANDOFF_CLAIMED: "prx",
  HANDOFF_DRAINED: "prx",
  HANDOFF_FAILED: "prx",
  HANDOFF_ABANDONED: "prx",

  // GH-1275 (PR-3 of GH-1261): dep-research per-run lifecycle events.
  DEP_RESEARCH_REQUESTED: "dep_research",
  DEP_FETCH_COMPLETED: "dep_research",
  DEP_SNAPSHOT_WRITTEN: "dep_research",
  DEP_DIFF_COMPUTED: "dep_research",
  DEP_DELTA_CLASSIFIED: "dep_research",
  DEP_RESEARCH_NO_DELTA: "dep_research",

  // GH-1537: beads↔external-mirror reconcile events. The per-pair ones are
  // emitted by `domainSyncMachine`; the tick-level ones (BUDGET_PAUSED,
  // TICK_COMPLETED) by the `runBeadsSync` routine.
  DOMAIN_SYNC_PAIR_STARTED: "domain_sync",
  DOMAIN_SYNC_PULLED: "domain_sync",
  DOMAIN_SYNC_PUSHED: "domain_sync",
  DOMAIN_SYNC_PAIR_DONE: "domain_sync",
  DOMAIN_SYNC_PAIR_FAILED: "domain_sync",
  DOMAIN_SYNC_BUDGET_PAUSED: "domain_sync",
  DOMAIN_SYNC_TICK_COMPLETED: "domain_sync",
  // GH-1469: `prx sync backfill` lifecycle. Emitted by the `runBackfill`
  // routine (src/sync/backfill.ts) — the range-backfill verb that heals
  // external records the forward-only sync cursor skipped (GH-1500 ADR §5).
  // Sibling of the per-pair `sync issues` reconcile; every event carries
  // `uow_id` (I-BF6, grounds I-AUD1).
  DOMAIN_SYNC_BACKFILL_STARTED: "domain_sync",
  DOMAIN_SYNC_BACKFILL_RECORD_MIRRORED: "domain_sync",
  DOMAIN_SYNC_BACKFILL_RECORD_SKIPPED: "domain_sync",
  DOMAIN_SYNC_BACKFILL_BUDGET_PAUSED: "domain_sync",
  DOMAIN_SYNC_BACKFILL_COMPLETED: "domain_sync",
  // GH-1662: cross-repo daemon per-repo lifecycle.
  DOMAIN_SYNC_REPO_STARTED: "domain_sync",
  DOMAIN_SYNC_REPO_COMPLETED: "domain_sync",
  DOMAIN_SYNC_REPO_SKIPPED: "domain_sync",

  // GH-1245: fetch actor spike events (documentary). GH-1603 adds the
  // write-path events that drive `fetchMachine`
  // (src/machine/machines/fetch.ts).
  FETCH_PLAN_COMPUTED: "fetch",
  FETCH_WATERMARK_READ: "fetch",
  FETCH_DRY_RUN_DECIDED: "fetch",
  FETCH_PAGE_FETCHED: "fetch",
  FETCH_PAGE_WRITTEN: "fetch",
  FETCH_PAGE_FAILED: "fetch",
  FETCH_WATERMARK_ADVANCED: "fetch",
  FETCH_RUN_COMPLETED: "fetch",
  FETCH_RUN_FAILED_MID_FETCH: "fetch",

  // GH-1659: cross-repo router lifecycle events. Mirrors fetch's event
  // shape — see `repoRouterMachine` (src/machine/machines/repo_router.ts).
  // `BARE_MATERIALIZED` is owned by `wt` (GH-1660 / #1676); the router
  // consumes it but does not own it, so it is intentionally absent here.
  BD_PREFIX_DETECTED: "repo_router",
  REPO_PIN_RESOLVED: "repo_router",
  SESSION_RE_DISPATCHED: "repo_router",
  ROUTE_REFUSED_NO_PIN: "repo_router",
  ROUTE_REFUSED_CONFLICT: "repo_router",
  ROUTE_FAILED: "repo_router",

  // GH-1768: derive actor's observability events. Audit-only — the
  // workflow machine never consumes them.
  DERIVE_FACTS_PROJECTED: "derive",
  DERIVE_QUERY_RUN: "derive",
  DERIVE_TRACE_EMITTED: "derive",

  // GH-1978: workspace lifecycle events. Owned by the new `workspace`
  // actor; driven by the `prx workspace <verb>` CLI (worktrunk is the
  // first and currently only driver). Documentary in the first cut —
  // no prSystem transitions consume them; they exist so the audit
  // substrate sees the per-workspace lifecycle alongside the existing
  // `wt` worktree events.
  WORKSPACE_RESERVED: "workspace",
  WORKSPACE_MATERIALIZED: "workspace",
  WORKSPACE_PREPARED: "workspace",
  WORKSPACE_SYNCED: "workspace",
  WORKSPACE_SERVICES_STARTED: "workspace",
  WORKSPACE_SERVICES_STOPPED: "workspace",
  WORKSPACE_TORN_DOWN: "workspace",
  WORKSPACE_OP_FAILED: "workspace",

  // GH-2009: dolt lifecycle events. Owned by the new `dolt` actor;
  // driven by the `prx dolt <verb>` CLI. Documentary in the first
  // cut — no prSystem transitions consume them; they exist so the
  // audit substrate sees the per-repo dolt-server lifecycle alongside
  // the existing `wt` worktree and `workspace` lifecycle events.
  // I-DOLT7 requires every event carry `dolt_server_id` + `uow_id`
  // (grounds I-AUD1/I-AUD2).
  DOLT_PROVISIONED: "dolt",
  DOLT_SERVER_STARTED: "dolt",
  DOLT_SERVER_HEALTHY: "dolt",
  DOLT_SERVER_STOPPED: "dolt",
  DOLT_SERVER_ORPHANED: "dolt",
  DOLT_ADOPTED: "dolt",
  DOLT_RECONCILED: "dolt",
  DOLT_RECONCILE_FAILED: "dolt",
  DOLT_MIRROR_REFRESHED: "dolt",
  DOLT_AUTO_PUSH_POLICY_SET: "dolt",
  DOLT_OP_FAILED: "dolt",
  // GH-1702: cross-repo fan-out emits (see catalog entry above).
  DOLT_SYNC_ALL_STARTED: "dolt",
  DOLT_SYNC_REPO_STARTED: "dolt",
  DOLT_SYNC_REPO_RECONCILED: "dolt",
  DOLT_SYNC_REPO_SKIPPED: "dolt",
  DOLT_SYNC_REPO_FAILED: "dolt",
  DOLT_SYNC_ALL_COMPLETED: "dolt",

  // GH-1495: temporal→durable memory digest events. Owned by the new
  // `transcripts_digest` actor; driven by `prx transcripts digest`. Each
  // event carries `uow_id` + `input_refs` in its details for I-TD3/I-AUD1/
  // I-AUD2 lineage. Routine actor (like `dep_research` / `domain_sync`) —
  // no prSystem transitions consume these.
  TRANSCRIPT_DIGEST_REQUESTED: "transcripts_digest",
  TRANSCRIPT_SOURCE_RESOLVED: "transcripts_digest",
  TRANSCRIPT_LOAD_COMPLETED: "transcripts_digest",
  TRANSCRIPT_PARSE_COMPLETED: "transcripts_digest",
  TRANSCRIPT_PARSE_LINE_SKIPPED: "transcripts_digest",
  TRANSCRIPT_EXTRACTION_COMPLETED: "transcripts_digest",
  TRANSCRIPT_DIGEST_STAGED: "transcripts_digest",
  TRANSCRIPT_DIGEST_COMMITTED: "transcripts_digest",
  TRANSCRIPT_DIGEST_NO_NEW_MEMORIES: "transcripts_digest",
  TRANSCRIPT_DIGEST_FAILED: "transcripts_digest",
  // Audit-row event surface used by `runTranscriptsDigest` for the
  // per-run summary row (kind: catalog-event).
  TRANSCRIPT_DIGEST_COMPLETED: "transcripts_digest",

  // GH-2027: session-open lifecycle events. Owned by the new
  // `session_open` actor; emitted by `sessionOpenMachine`
  // (src/machine/machines/session-open.ts) at every transition of
  // the naming → reserving → preparing → dispatching → opened/failed_*
  // graph. Each event carries `workspace_id` (when known) + `uow_id`
  // per I-SO3, grounding I-AUD1/I-AUD2/I-AUD4 for session-entry.
  SESSION_OPEN_REQUESTED: "session_open",
  SESSION_OPEN_NAME_DERIVED: "session_open",
  SESSION_OPEN_RESERVED: "session_open",
  SESSION_OPEN_MATERIALIZED: "session_open",
  SESSION_OPEN_PREPARED: "session_open",
  SESSION_OPEN_DISPATCHED: "session_open",
  SESSION_OPEN_FAILED: "session_open",

  // prx-wt5: merge-conflict reconciliation events. Owned by the new
  // `mediator` actor; emitted by `mediatorMachine`
  // (src/machine/machines/mediator.ts) across the
  // detecting → conflicted → resolving → resolved → reconciled graph (plus
  // the aborted / failed terminals). Each event carries `uow_id` + `branch`
  // + `base_ref` per I-MED2, grounding I-AUD1/I-AUD2. The mediator owns the
  // `RECONCILE_CONTINUE_REQUESTED` *intent* only — the matching effect
  // (`git rebase --continue`) stays owned by `git`/`keeper` (I-MED4), the
  // same intent⟂effect split as keeper⟂git. `RESTAGE_REQUESTED` is the
  // handoff into `prx submit stage` so the rebased tree flows to `publish`.
  CONFLICT_DETECTED: "mediator",
  CONFLICT_CLASSIFIED: "mediator",
  MEDIATION_STARTED: "mediator",
  RESOLUTION_OBSERVED: "mediator",
  RECONCILE_CONTINUE_REQUESTED: "mediator",
  MEDIATION_ABORTED: "mediator",
  RECONCILE_COMPLETED: "mediator",
  RESTAGE_REQUESTED: "mediator",

  // Backwards compatibility aliases used in existing machine events.
  SUBMIT: "gh",
  CONVERT_TO_DRAFT: "gh",
  REQUEST_REVIEW: "gh",
  APPROVE: "gh",
  CLOSE: "gh",
  REOPEN: "gh",
  MERGE: "gh",
  MERGEABILITY_UNKNOWN: "gh",
  MERGEABILITY_CLEAN: "gh",
  MERGEABILITY_BLOCKED: "gh",
  MERGEABILITY_DIRTY: "gh",
  CI_QUEUE: "remote_ci",
  CI_START: "remote_ci",
  CI_PASS: "remote_ci",
  CI_FAIL: "remote_ci",
  REQUEST_CHANGES: "gh",
};

export const rawFieldOwnerMap: Record<string, ToolActor> = {
  "branch.local.exists": "git",
  "branch.local.checked_out": "git",
  "branch.local.ahead": "git",
  "branch.local.behind": "git",
  "branch.remote.exists": "gh",
  "branch.remote.fresh": "gh",
  "worktree.exists": "wt",
  "worktree.path": "wt",
  "worktree.prunable": "wt",
  "worktree.dirty": "wt",
  "pr.exists": "gh",
  "pr.number": "gh",
  "pr.lifecycle": "gh",
  "pr.review.status": "gh",
  "pr.mergeability": "gh",
  "ci.status": "remote_ci",
  "ci.required_passed": "remote_ci",
  "task.exists": "beads",
  "task.id": "beads",
  "task.status": "beads",
  "task.currentRole": "prx",
  "task.handoffStatus": "prx",
  "task.specSynced": "prx",
  "ticket.exists": "notion_mcp",
  "ticket.id": "notion_mcp",
  "tmux.socket.exists": "tmux",
  "tmux.option.live_value": "tmux",
  "tmux.option.config_value": "tmux",
  // GH-2009: per-repo dolt-server ledger fields. Mirrors the wt/gh
  // raw-field pattern so the audit substrate sees lifecycle state
  // alongside existing PR/workspace state. Stored atomically (I-DOLT3)
  // at `<repoCommonDir>/info/dolt/<dolt_server_id>.json`.
  "dolt.server.pid": "dolt",
  "dolt.server.port": "dolt",
  "dolt.server.dsn": "dolt",
  "dolt.server.owner": "dolt",
  "dolt.mirror.path": "dolt",
};

export function actorForEvent(eventType: string): ToolActor | null {
  return eventOwnerMap[eventType] ?? null;
}

export function actorsForScope(scope: ActorScope): ToolActorSpec[] {
  return actorScopes[scope].map((name) => toolActorCatalog[name]);
}

export function eventOwnersForScope(scope: ActorScope): Record<string, ToolActor> {
  const allowed = new Set(actorScopes[scope]);
  return Object.fromEntries(
    Object.entries(eventOwnerMap).filter(([, owner]) => allowed.has(owner)),
  );
}

export function rawFieldOwnersForScope(scope: ActorScope): Record<string, ToolActor> {
  const allowed = new Set(actorScopes[scope]);
  return Object.fromEntries(
    Object.entries(rawFieldOwnerMap).filter(([, owner]) => allowed.has(owner)),
  );
}
