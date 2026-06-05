// Canonical actor-name vocabulary (GH-1530). Single leaf source of truth for
// the actor-name tuple shared across three boundaries that would otherwise
// form an ESM import cycle:
//   - the CLI registry's `ActorName` enum (`src/cli/registry.ts` does
//     `z.enum(actorNames)`),
//   - the dispatch taxonomy (`src/machine/dispatch.ts` sets
//     `dispatchActors = actorNames`), and
//   - the registry-derived per-actor permission helper
//     (`src/machine/actor_ruleset.ts`).
//
// This module imports nothing but `zod` consumers downstream — it is a pure
// leaf (no runtime deps), so importing it from registry.ts AND dispatch.ts AND
// runtime_profiles.ts (via actor_ruleset.ts) cannot reintroduce the
// registry → runtime_profiles cycle the GH-1530 plan flagged as hazard #2.
//
// Per-actor rationale comments live with each entry below; they were lifted
// verbatim from `registry.ts`'s former inline `ActorName` enum.

export const actorNames = [
  // GH-1823: read-only audit verb that measures architectural adherence
  // (uow attachment, artifact coverage, lineage completeness, guarded
  // transitions, ambient-git violations, patch-evidence chain, derivable
  // status). Verbs: `audit ingest`, `audit uow <id>`, `audit system`.
  "audit",
  // GH-1206: PR-author actor — produces the reviewable PR body between
  // implement and prune. Verbs: `author session` (lifecycle),
  // `author body-template` (toolset).
  "author",
  "beads",
  // GH-1761: registry-side branch actor for `prx branch adopt`. Sits
  // alongside the `repo` actor in the GH-1759 registry layer; the existing
  // `worktree` actor stays focused on git-worktree filesystem ops.
  "branch",
  "chain",
  "contract",
  // GH-983: filter-aware portfolio picker — supersedes `worktree next`.
  // Planning-tier actor. v0 surface is one verb (`delegate next`) that
  // projects `nextWork()`'s eight-thread output into a top-1 (default)
  // or full (`--all`) filtered pick. Name reflects the operator intent:
  // queueing work for a worktree/session/agent, not manipulating a
  // worktree. The verb-object word order ("worktree next") that lived
  // here through GH-1510's deprecation window retires with this entry.
  "delegate",
  // GH-1768: Datalog-as-derived-truth spike. Read-only planner-tier
  // actor; verbs `ready / drift / eligible / why / dump-facts` query
  // a Horn-clause evaluator over projected facts. No mutating verbs,
  // no machine-event emits beyond the three observability events
  // wired in `src/machine/actors.ts`. Stays in the catalog only if the
  // spike retro recommends promote; on discard, both the actor and
  // its verbs retire together.
  "derive",
  "doctor",
  "dolt",
  // GH-1990: canonical actor surface for bd↔external reconcile. Mirrors the
  // workflow-tier `domain_sync` actor (`src/machine/actors.ts:348`) into the
  // CLI registry's `ActorName` enum so registry entries can name it as their
  // owning actor. The verbs (`sync`, `sync issues`) are operator-facing aliases
  // over the per-pair `domainSyncMachine` (`src/sync/machine.ts`) and the
  // pull-only delegate in `src/tools/bd.ts:runBdGithubSyncPullOnly`.
  "domain_sync",
  // GH-1245: 2-day spike for the external→substrate refresh chokepoint
  // (docs/fetch-actor-spike.md). `fetch gh-issues --dry-run` is the v0
  // verb; the actor stays in the catalog after the spike so the post-spike
  // write ticket can wire its events to phase transitions without
  // churning the registry twice.
  "fetch",
  // prx-gr1: GitHub-write / forge-custody actor — the twin of `keeper` (git).
  // Owns ALL gh writes (issues, labels, comments, PRs, merges) so the capability
  // lives in one actor (role=forge in the policy table) rather than scattered
  // across executor / reviewer / publisher; other actors dispatch gh to it. The
  // PR/merge boundary artifacts (pr@pinned, merge/v1) are produced here.
  "forge",
  // GH-2026/GH-2327: unified housekeeping actor. One actor, three verbs across
  // two classes — sweep (`gc inventory`, `gc run`; dry-run by default) and
  // targeted (`gc teardown`; acts by default). First-class actor, NOT folded
  // into `prx tools`/`doctor` (GH-1934). The `prune`→`gc` rename of the
  // dispatch taxonomy is a separate task (sibling 2l4ua); this enum entry is
  // the CLI-registry taxonomy and lands here.
  "gc",
  // GH-1397: structured handoff queue for executor-blocked verbs. Plumbing
  // under every actor — when a harness-denied verb is detected, the
  // originating actor enqueues a typed envelope for the recipient
  // (publisher / triage / submit / author / noop). v0 verbs:
  // `handoff enqueue / status / drain / replay`.
  "handoff",
  "help",
  "home",
  "hooks",
  // GH-1530: `implement` is the executor session profile's CLI namespace
  // (`prx implement agent`). Its registry commands are owned by the `work`
  // actor (the namespace string is `implement`, the canonical actor is
  // `work`), so `implement` was not previously an `ActorName`. It is added to
  // the shared vocabulary here because (a) it is already a `dispatchActors`
  // member and the GH-1530 ocap redesign unifies the two sets, and (b) the
  // implement session profile keys `actorRuleset("implement")` on it to derive
  // its `Bash(prx implement:*)` glob. `commandsByActor("implement")` is empty
  // by design — the namespace-based ruleset guard validates via the `prx
  // implement` command namespace (parent), not the `actor` field.
  "implement",
  "init",
  "intake",
  // GH-2348.3: git-write / ref-custody actor — owns push + branch ops, split
  // out of `publisher` (now forge-only). GH-2353 registered `keeper` in the
  // machine actor catalog; this entry mirrors it into the CLI registry so the
  // `keeper push|branch` command entries can name it as their owner.
  "keeper",
  // GH-2016: roadmap actor — named, cross-tree initiatives captured at
  // `.prx/maps/<name>.json` and projected into bd-graph edges. v0 verbs:
  // `map create`, `map show`. `map next` / `map sync` ship as stubs in
  // PR-1 and unstub in their respective child PRs.
  "map",
  // GH-1513: bd-side memory-decay policy chokepoint. `memory compact` is
  // the v0 verb; the actor leaves room for future memory-engine verbs
  // (memory inspect / memory decay) without churning the registry.
  "memory",
  // prx-wt5: merge-conflict reconciliation actor. The mediator *facilitates*
  // a rebase onto a moved base (detect → classify → model the lifecycle); it
  // writes nothing to the working tree (I-MED1) and emits the
  // `RECONCILE_CONTINUE_REQUESTED` intent only — the `git rebase
  // --continue/--abort` effects stay with git/keeper (I-MED4). The
  // impose/auto-resolve variant is a future `arbiter` sibling.
  "mediator",
  "model",
  "plan",
  "preflight",
  "prune",
  // GH-1559: publication actor — owns the PR publication-transition verbs
  // moved off `doctor` per the GH-1398 ADR §4 split (read/diagnose vs.
  // publish). GH-1558 registered `publisher` in the machine actor catalog;
  // this entry mirrors it into the CLI registry's `ActorName` enum so the
  // `publisher merge|ready|draft` command entries can name it as their owner.
  "publisher",
  "repo",
  // GH-1423: rules-as-build-substrate spike. Renders claude/rules/*.md
  // from typed inputs (verb-supply / alias-supply / worktree-gestures /
  // memory-index) and validates that backticked claims resolve against
  // the live substrate. The drift-canary that justifies the actor is
  // `claude/rules/core.md:96`'s `za`/`zb`/`zc` alias claim: no
  // home-manager module defines those aliases, but the rules ship the
  // claim as fact. The validator wraps alias-exists assertions in
  // `<!-- assert:alias -->` HTML fences so the failure is surfaced as
  // a typed event (`RULES_ASSERTION_FAILED`) once alias-supply lands.
  "rules",
  "scout",
  // GH-2394: ad-hoc, work-unit-UNBOUND least-privilege session actor. Owns the
  // bare `prx scratch` command (safe by default; `--unsafe` escape hatch). Not
  // a workflow actor or phase — a session profile riding the planning-tier
  // claude_code implementation.
  "scratch",
  // GH-1407: external-service status actor — read-only projector over the
  // `non-interactive-agent/usage` audit rows. Ships `services status
  // --anthropic` (prompt-cache hit rate per profile/actor/workUnitId);
  // per-actor budget planes belong to GH-1826.
  "services",
  // prx-tth (epic prx-9zh): the scope verification gate. A read-only CLI verb
  // (`scope-gate run <unit>`) that checks implement.files_changed ⊆ plan.paths
  // and emits a signed `gate/v1` verdict. Like `audit`, it is registry/CLI
  // vocabulary only — not a machine `toolActorCatalog` actor (it owns no XState
  // events; its side effect is the signed ledger attestation).
  "scope-gate",
  // GH-1318: post/pre-merge cleanup actor for issues GitHub does not
  // auto-close because the PR title's `(GH-N)` suffix is decorative, not a
  // close-keyword. Ships two verbs: `submit body-template` (pre-merge `Closes
  // #N` emitter) and `submit postmerge` (post-merge body-sweep + close).
  "submit",
  "tmux",
  "tools",
  // GH-1495: temporal→durable memory pipeline. The Claude Code transcript
  // tree at `~/.claude/projects/<encoded>/*.jsonl` carries a 30-day TTL;
  // `transcripts digest` is the chokepoint that compresses those transcripts
  // (plus rescued archives and claude.ai web exports) into durable memory
  // shards before they age out. Producer side of the principle recorded on
  // GH-1491: temporal artifacts must digest into long-lived deterministic
  // memories. Downstream consumers: GH-1497 (`domain:` field on shards),
  // GH-1491 (memory export/import), GH-1485 (triage front-end for staged
  // candidates).
  "transcripts",
  "triage",
  "work",
  // GH-1762: registry-side workspace actor for `prx workspace adopt`.
  // Sits alongside `repo` and `branch` in the GH-1759 registry layer; the
  // existing `worktree` actor stays focused on git-worktree filesystem ops.
  "workspace",
  "worktree",
] as const;

export type ActorName = (typeof actorNames)[number];
