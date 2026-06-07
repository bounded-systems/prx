// prx command registry data + helpers (GH-1242 PR-1).
//
// Sibling to `./registry.ts` (schemas/types). The split is one-directional:
// this module imports from `./registry.ts`, never the reverse. That keeps the
// top-level `z.array(CommandSpec).parse(RAW_REGISTRY)` safe — no ESM TDZ
// hazard from a cyclic import where `CommandSpec` would be uninitialized at
// data.ts evaluation time.
//
// The plan named `findCommand`/`promotedFor`/`commandsByActor` as helpers
// owned by `./registry.ts`. They live here instead so `./registry.ts` has no
// dependency on the entry table — the only practical structure that avoids
// the cycle. Consumers split imports: schemas/types from `./registry.ts`,
// entries + helpers from this file.

import { z } from "zod";

import {
  type ActorName,
  ActorSpec,
  CommandSpec,
  type SessionContext,
} from "./registry.ts";
// GH-2026/GH-2327: wire the gc actor's boundary-layer input schemas into
// `CommandSpec.args` (GH-1242 substrate). schema.ts imports only zod, so this
// is cycle-safe.
import {
  InventoryInput as GcInventoryInput,
  RunInput as GcRunInput,
  TeardownInput as GcTeardownInput,
} from "../machine/gc/schema.ts";

const RAW_REGISTRY: z.input<typeof CommandSpec>[] = [
  // ─── Promoted on mainx (help-surface.md §6.2: exactly six, in canonical order) ─

  {
    name: "tui",
    description: "Interactive board and session UI",
    domain: "work-units",
    promoted_in: ["mainx"],
    actor: "work",
  },
  {
    name: "plan session",
    parent: "plan",
    description: "Open plan-mode work session for a unit",
    domain: "work-units",
    binding: "work-unit",
    session_profile: "plan",
    session_role: "lifecycle",
    promoted_in: ["mainx", "plan"],
    actor: "plan",
  },
  {
    // GH-1166: canonical replacement for `session next` after the bare-session
    // namespace retired. `prx next` was already a top-level alias; this entry
    // makes it the registry-promoted form on mainx.
    name: "next",
    description: "Show next recommended action",
    domain: "work-units",
    binding: "work-unit",
    promoted_in: ["mainx"],
    actor: "work",
  },
  {
    name: "do",
    description: "Execute an enabled derived action",
    domain: "work-units",
    binding: "work-unit",
    promoted_in: ["mainx"],
    actor: "work",
  },
  {
    name: "review",
    description: "Send review into the live tmux pane",
    domain: "work-units",
    binding: "work-unit",
    promoted_in: ["mainx"],
    actor: "work",
  },

  // ─── Other session-entry profiles (verb-object, §4) ────────────────────────

  {
    name: "intake agent",
    parent: "intake",
    description: "Run the mainx intake operator (headless by default, --interactive for tmux/PTY)",
    domain: "work-units",
    binding: "mainx",
    session_profile: "intake",
    actor: "intake",
  },
  {
    name: "triage agent",
    parent: "triage",
    description: "Run the mainx triage operator (headless by default, --interactive for tmux/PTY)",
    domain: "work-units",
    binding: "mainx",
    session_profile: "triage",
    actor: "triage",
  },
  {
    // GH-1740: submit operator session — pre-merge `Closes #N` staging +
    // post-merge orphan sweep.
    // GH-1900: flipped to work-unit binding. The session prepares a
    // CAS-backed submit artifact for the bound unit and hands off to
    // `prx submit publish --from-cas <ref>`.
    name: "submit agent",
    parent: "submit",
    description: "Run the work-unit submit operator (headless by default, --interactive for tmux/PTY)",
    domain: "work-units",
    binding: "work-unit",
    session_profile: "submit",
    actor: "submit",
  },
  {
    // GH-1172: executor-profile entry for a planned work unit. Distinct
    // from `plan session` (read-only planner): implement opens with
    // Edit/Write enabled and tags the tmux session with `-implement`.
    // GH-1981: renamed `implement session` → `implement agent` (the verb
    // token `agent` says "this spawns a Claude agent", per the GH-1943
    // ADR). `implement session` lives on for one cycle as a deprecation
    // alias (entry below) and the flat `prx implement <id>` shape is
    // hard-removed. Not promoted in plan context: §6.2 caps at six and
    // the implement verb is reachable from inside plan mode via the
    // banner prompt.
    name: "implement agent",
    parent: "implement",
    description: "Open implement-mode work session for a unit",
    domain: "work-units",
    binding: "work-unit",
    session_profile: "implement",
    actor: "work",
  },
  {
    // GH-1206: author operator session — PR-body authoring profile between
    // implement and prune. Work-unit-bound; read+gh-pr-only allowlist
    // (no Edit/Write on source, no `git push`, no `gh pr merge`).
    name: "author agent",
    parent: "author",
    description: "Run the work-unit PR author (headless by default, --interactive for tmux/PTY)",
    domain: "work-units",
    binding: "work-unit",
    session_profile: "author",
    session_role: "lifecycle",
    actor: "author",
  },
  {
    // GH-1206: pure body-template renderer. Reads plan + diff + issue and
    // emits a CLAUDE.md PR-Standards run-sheet body.
    name: "author body-template",
    parent: "author",
    description: "Render PR body from plan and diff",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "author",
  },
  {
    // GH-2394: `prx scratch` — bare command (no parent / sub-verb). An ad-hoc,
    // work-unit-UNBOUND least-privilege Claude session that is SAFE BY DEFAULT
    // (permission flag-layer + MCP lockdown incl. the claude.ai connector
    // kill-switch + macOS sandbox). `prx scratch --unsafe` is the single escape
    // hatch back to ambient authority. Reuses the `mainx` binding (unbound, no
    // workspace reserve — the intake/triage precedent). See
    // docs/prx/scratch-runbook.md.
    name: "scratch",
    description: "Open safe-by-default ad-hoc Claude session (--unsafe for ambient authority)",
    domain: "work-units",
    binding: "mainx",
    session_profile: "scratch",
    actor: "scratch",
  },

  // ─── Deprecated session aliases (§3 / §8) ──────────────────────────────────
  //
  // prx-rgr: `prx session open` / `prx session plan` are retired (no `prx
  // session` surface). The interactive planning entry is `prx plan session` /
  // `prx plan agent`; the internal claude runtime launcher moved to the
  // top-level `prx claude` (below).

  {
    // prx-rgr: the internal claude runtime-bootstrap launcher (formerly
    // `prx session open-claude`). Work-unit-bound; boots the interactive
    // claude plan pane. Kept off the help sitemap's main flow — it is the
    // low-level launcher `prx plan session` / `prx implement agent` rely on.
    name: "claude",
    description: "Internal claude runtime launcher (formerly session open-claude)",
    domain: "work-units",
    binding: "work-unit",
    actor: "plan",
  },
  {
    name: "open",
    description: "Deprecated alias for plan session",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "plan session",
      removal_target: "#582 / #833",
      stderr_hint:
        "prx open is deprecated; use `prx plan session [GH-NNN]`.",
    },
    actor: "plan",
  },
  {
    name: "work",
    description: "Deprecated alias for plan session",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "plan session",
      removal_target: "#582",
      stderr_hint:
        "prx work is deprecated; use `prx plan session [GH-NNN]`.",
    },
    actor: "plan",
  },
  {
    // GH-1981: one-cycle deprecation alias for the renamed `implement
    // session` → `implement agent` verb. The CLI accepts both shapes and
    // emits the stderr hint when the legacy `session` head token is
    // used. Hard-removed alongside the GH-1242 PR-5 sweep.
    name: "implement session",
    parent: "implement",
    description: "Deprecated alias for implement agent",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "implement agent",
      removal_target: "GH-1242 PR-5",
      stderr_hint:
        "prx implement session is deprecated; use `prx implement agent [GH-NNN]`.",
    },
    actor: "work",
  },

  // ─── plan.* leaves — promoted in plan session-context (§6.2, GH-978) ───────

  {
    // GH-1166: also mainx-promoted (replaces the retired `session close` slot
    // in the canonical-six mainx set). Same handler: post-merge teardown that
    // refuses unless the PR has merged.
    name: "plan handoff",
    parent: "plan",
    description: "Post-merge handoff from feature worktree",
    domain: "work-units",
    binding: "work-unit",
    session_role: "lifecycle",
    promoted_in: ["plan", "mainx"],
    actor: "plan",
  },
  {
    // GH-1057: close-without-merge sibling to `plan handoff` (post-merge).
    // Carries actor identity for hooks gating raw `gh issue close`.
    name: "plan close",
    parent: "plan",
    description: "Close work unit issue with operator context",
    domain: "work-units",
    binding: "work-unit",
    session_role: "lifecycle",
    promoted_in: ["plan"],
    actor: "plan",
  },
  {
    // GH-1057: dropped from plan-promoted set to make room for `plan close`
    // (§6.2 cap of six). Operators reach this verb as `prx ultrareview` from
    // mainx-context; the `plan ultrareview` namespaced spelling still resolves.
    name: "plan ultrareview",
    parent: "plan",
    description: "Pre-fill ultrareview into the work-unit pane",
    domain: "work-units",
    binding: "work-unit",
    session_role: "preflight",
    actor: "plan",
  },
  {
    name: "plan ci",
    parent: "plan",
    description: "Run canonical pre-push validation locally",
    domain: "work-units",
    binding: "work-unit",
    session_role: "preflight",
    promoted_in: ["plan"],
    actor: "plan",
  },
  {
    name: "plan status",
    parent: "plan",
    description: "Show current phase for the unit",
    domain: "work-units",
    binding: "work-unit",
    session_role: "preflight",
    promoted_in: ["plan"],
    actor: "plan",
  },
  {
    name: "plan next",
    parent: "plan",
    description: "Show next recommended action",
    domain: "work-units",
    binding: "work-unit",
    session_role: "preflight",
    promoted_in: ["plan"],
    actor: "plan",
  },
  // GH-1056: pre-tmux setup of `plan session` exposed as its own verb.
  // Non-promoted by IA decision GH-1082: `plan prime` is a sub-step of
  // `plan session` (scripting / recovery), not a daily-loop slot. Stays
  // discoverable via `prx plan --help` and `prx help-all`.
  {
    name: "plan prime",
    parent: "plan",
    description: "Pre-stage worktree rebase and hydrate without tmux",
    domain: "work-units",
    binding: "work-unit",
    session_role: "lifecycle",
    actor: "plan",
  },
  // GH-1173: operator-facing verbs over the GH-1174 CAS plan store. Non-
  // promoted — §6.2 caps the plan-context promoted set at six and the slots
  // are taken (handoff, close, ci, status, next plus prime is non-promoted).
  // Discoverable via `prx plan --help`.
  {
    name: "plan save",
    parent: "plan",
    description: "Persist a plan blob (see plan show --paths for location)",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "plan",
  },
  {
    name: "plan load",
    parent: "plan",
    description: "Load a plan blob from the CAS plan store",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "plan",
  },
  {
    name: "plan show",
    parent: "plan",
    description: "Show plan blob; --slot pins, default approved with draft fallback",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "plan",
  },
  // GH-1186: planner-side read primitives — twins of `intake view` /
  // `intake search`. Non-promoted: §6.2 caps the plan-context promoted set
  // at six (handoff/close/ci/status/next/session — already full). These
  // stay discoverable via `prx plan --help` and `prx help-all`, same shape
  // as `plan save / load / show`.
  {
    name: "plan view",
    parent: "plan",
    description: "View an issue (GH/bd/Notion id, URL)",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "plan",
  },
  {
    name: "plan search",
    parent: "plan",
    description: "Search GH+bd issue queue (deduped)",
    domain: "work-units",
    binding: "work-unit",
    session_role: "toolset",
    actor: "plan",
  },
  // GH-1239: deterministic pre-draft preflight (already-done / allowlist-
  // feasibility / blocked-by-open-deps). Non-promoted — runs as the auto-
  // step in `plan session`, but discoverable as a standalone verb via
  // `prx plan --help`.
  {
    name: "plan preflight",
    parent: "plan",
    description: "Pre-draft three-axis check before a plan session",
    domain: "work-units",
    binding: "work-unit",
    session_role: "preflight",
    actor: "plan",
  },

  // ─── session.* leaves retired (GH-1166) ───────────────────────────────────
  //
  // The bare-`prx session <verb>` namespace is no longer a verb. Read-side
  // subcommands moved to their canonical actor-owned homes:
  //   prx session next        → prx next
  //   prx session do          → prx do
  //   prx session close       → prx plan handoff
  //   prx session status      → prx phase
  //   prx session phase       → prx phase
  //   prx session snapshot    → prx snapshot
  //   prx session statusline  → prx statusline
  //   prx session actions     → prx actions
  //   prx session refresh     → prx worktree refresh
  //   prx session check       → prx chain check
  //   prx session check-issue → prx chain check-issue
  //   prx session check-session → prx chain check-session
  //   prx session check-chain → prx chain check
  //
  // prx-rgr: `prx session open` / `prx session plan` / the bare `prx session
  // <id>` shorthand are retired — there is no `prx session` surface. The
  // planning entry is `prx plan session` (interactive) / `prx plan agent`
  // (headless); the internal claude runtime launcher moved to the top-level
  // `prx claude` (registered above). `prx session --help` still prints a
  // redirect map from cli.ts but is not registry-surfaced.

  // ─── Other work-unit verbs ─────────────────────────────────────────────────

  {
    name: "ultrareview",
    description: "Pre-fill ultrareview into the pane",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },
  {
    name: "ci",
    description: "Run canonical pre-push validation locally",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },

  // ─── Workflow-state read verbs (GH-1166) ──────────────────────────────────
  // These are projections owned by the `prx` actor (workflow tier `planning`,
  // accepts: status, snapshot, actions, phase). They were previously reachable
  // only via `prx session <verb>`; the bare-session namespace is retired and
  // these are now first-class top-level verbs.

  {
    name: "phase",
    description: "Show current phase for the unit",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },
  {
    name: "snapshot",
    description: "Emit full session snapshot json",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },
  {
    name: "statusline",
    description: "Emit single-line statusline projection",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },
  {
    name: "actions",
    description: "List suggested actions for the unit",
    domain: "work-units",
    binding: "work-unit",
    actor: "work",
  },

  // ─── intake.* leaves ───────────────────────────────────────────────────────

  {
    name: "intake spike",
    parent: "intake",
    description: "File an intake-log spike issue",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake decision",
    parent: "intake",
    description: "File an intake-log design-decision issue",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake bug",
    parent: "intake",
    description: "File an intake-log bug issue",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake task",
    parent: "intake",
    description: "File an intake-log task issue",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake feature",
    parent: "intake",
    description: "File an intake-log feature issue",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake view",
    parent: "intake",
    description: "View an issue (GH/bd/Notion id, URL)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake search",
    parent: "intake",
    description: "Unified GH+bd dedupe search before filing",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake merge",
    parent: "intake",
    description: "Pointer comment + close (atomic dedupe)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake comment",
    parent: "intake",
    description: "Pointer comment without close",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake mirror",
    parent: "intake",
    description: "Idempotent bd create from a GH issue (race-checked)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake bd ls",
    parent: "intake",
    description: "List bd issues (narrow `bd list` wrapper)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake bd memory ls",
    parent: "intake",
    description: "List or search bd memories (narrow `bd memories` wrapper)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake bd memory get",
    parent: "intake",
    description: "Read a bd memory by key (narrow `bd recall` wrapper)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    name: "intake bd memory set",
    parent: "intake",
    description: "Upsert a bd memory by key (narrow `bd remember` wrapper)",
    domain: "work-units",
    binding: "mainx",
    actor: "intake",
  },
  {
    // GH-232: the intake role (human OR agent) owns the chain ROOT. A plain
    // deterministic verb so either an operator types it or an intake agent calls
    // it — `actor: intake` is the capability label, not an agent-only gate.
    name: "intake source",
    parent: "intake",
    description: "Pin a work unit's source authority as <unit>:source@pinned",
    domain: "work-units",
    binding: "work-unit",
    actor: "intake",
  },

  // ─── triage.* leaves ───────────────────────────────────────────────────────

  {
    name: "triage status",
    parent: "triage",
    description: "List untriaged issues, reverse orphans, drift, stale beads; closed-as-dup excluded (GH-1829)",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    name: "triage classify",
    parent: "triage",
    description: "Classify open issues by axis",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    name: "triage apply",
    parent: "triage",
    description: "Apply classifier output to GitHub labels",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    name: "triage promote",
    parent: "triage",
    description: "Promote execution-ready issues into beads",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    // GH-1351: file Ultraplan-staged child issues + wire dep edges in one
    // verb so triage no longer drops into manual `prx intake` / `bd dep add`
    // loops for plan-supplied child sets.
    name: "triage promote-children",
    parent: "triage",
    description: "File child issues from a staging dir manifest",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    name: "triage type-pass",
    parent: "triage",
    description: "Bulk-classify type-less issues via Haiku",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  {
    // GH-1719: actor-tied close for bd-only records (no GH mirror). Resolves
    // the lower half of the reverse-orphan lifecycle (bd-only → closed); the
    // upper half (bd-only → published-to-GH) lives in `prx beads publish`
    // (GH-1507). GH-linked beads stay on `prx plan close GH-N`; this verb
    // refuses when `external_ref` is set.
    name: "triage close",
    parent: "triage",
    description: "Close a bd-only record (no GH mirror)",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  // GH-1782: bulk-close beads whose linked GH issue is already closed (the
  // action-counterpart to `prx triage status`'s `stale` projection). bd-only
  // write — no GH state mutated.
  {
    name: "triage close-stale",
    parent: "triage",
    description: "Bulk-close beads whose linked GH issue is already closed",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },
  // GH-1015: orchestrator that drives the untriaged count toward 0 by looping
  // the existing classify/apply/(priority)/promote chain on the GH-1052
  // machine until the queue stabilizes.
  {
    name: "triage prime",
    parent: "triage",
    description: "Drive the untriaged count toward 0",
    domain: "work-units",
    binding: "mainx",
    actor: "triage",
  },

  // ─── map.* leaves (GH-2016) ───────────────────────────────────────────────
  //
  // PR-1 ships `create` + `show` against the real verbs. `next` and `sync`
  // ship as actor-level stubs (`MapStubError`) so the registry surface is
  // complete in one place — child PR-2 (sync projection) and PR-3 (ready
  // ranking) of GH-2016 unstub each in turn. `internal: true` keeps the
  // stubbed pair out of the promoted help table until they land.

  {
    name: "map create",
    parent: "map",
    description: "Capture a named cross-tree initiative as a map",
    domain: "work-units",
    binding: "mainx",
    actor: "map",
  },
  {
    name: "map show",
    parent: "map",
    description: "Render a stored map's sequence and rationale",
    domain: "work-units",
    binding: "mainx",
    actor: "map",
  },
  {
    name: "map next",
    parent: "map",
    description: "Project per-map next-ready ticket (stub)",
    domain: "work-units",
    binding: "mainx",
    actor: "map",
    internal: true,
  },
  {
    name: "map sync",
    parent: "map",
    description: "Project map edges into bd graph (stub)",
    domain: "work-units",
    binding: "mainx",
    actor: "map",
    internal: true,
  },

  // ─── State domain ──────────────────────────────────────────────────────────

  {
    name: "model show",
    parent: "model",
    description: "Print machine model summary",
    domain: "state",
    actor: "model",
  },
  {
    name: "model actors",
    parent: "model",
    description: "List actors in the workflow model",
    domain: "state",
    actor: "model",
  },
  {
    name: "model graph",
    parent: "model",
    description: "Emit machine graph in chosen format",
    domain: "state",
    actor: "model",
  },
  {
    name: "model stately",
    parent: "model",
    description: "Open machine in Stately registry",
    domain: "state",
    actor: "model",
  },
  {
    name: "chain status",
    parent: "chain",
    description: "Show parity chain status across repos",
    domain: "state",
    actor: "chain",
  },
  {
    name: "chain check",
    parent: "chain",
    description: "Run parity check for a unit",
    domain: "state",
    actor: "chain",
  },
  {
    name: "chain check-issue",
    parent: "chain",
    description: "Check issue parity for a unit",
    domain: "state",
    actor: "chain",
  },
  {
    name: "chain check-session",
    parent: "chain",
    description: "Check session parity for a unit",
    domain: "state",
    actor: "chain",
  },
  {
    name: "chain prune",
    parent: "chain",
    description: "Prune stale parity chain leaves",
    domain: "state",
    actor: "chain",
  },
  {
    name: "prune session",
    parent: "prune",
    description: "Tear down tmux + resurrect state for a unit (worktree intact)",
    domain: "state",
    actor: "prune",
  },
  // GH-2026/GH-2327: unified housekeeping actor `prx gc <verb>`. Three verbs,
  // two classes — sweep (`inventory`/`run`, dry-run by default) and targeted
  // (`teardown`, acts by default). Drivers are a `--component` dimension of
  // `run`/`inventory`, not separate verbs. `args` wires the boundary-layer
  // input schemas (GH-1242 substrate). The `prune`→`gc` rename stays out of
  // scope here (sibling 2l4ua); both surfaces coexist for now.
  {
    name: "gc",
    description: "Reclaim and reconcile housekeeping across the system",
    domain: "state",
    actor: "gc",
  },
  {
    name: "gc inventory",
    parent: "gc",
    description: "Discover reclaimable housekeeping items without mutating anything",
    domain: "state",
    actor: "gc",
    args: GcInventoryInput,
  },
  {
    name: "gc run",
    parent: "gc",
    description: "Sweep reclaimable items (dry-run by default; --apply acts)",
    domain: "state",
    actor: "gc",
    args: GcRunInput,
  },
  {
    name: "gc teardown",
    parent: "gc",
    description: "Fully tear down a named work-unit (acts by default)",
    domain: "state",
    actor: "gc",
    args: GcTeardownInput,
  },
  {
    name: "chain backfill",
    parent: "chain",
    description: "Backfill missing parity chain entries",
    domain: "state",
    actor: "chain",
  },
  {
    name: "chain sync",
    parent: "chain",
    description: "Sync parity chain across authorities",
    domain: "state",
    actor: "chain",
  },
  {
    name: "contract show",
    parent: "contract",
    description: "Show current PR contract content",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract init",
    parent: "contract",
    description: "Initialize a new PR contract",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract status",
    parent: "contract",
    description: "Show PR contract status",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract transition",
    parent: "contract",
    description: "Transition the PR contract state",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract event",
    parent: "contract",
    description: "Emit an event onto the contract",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract skills",
    parent: "contract",
    description: "List skills enabled by the contract",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract open-mode",
    parent: "contract",
    description: "Show or compute open-mode for contract",
    domain: "state",
    actor: "contract",
  },
  {
    name: "contract update",
    parent: "contract",
    description: "Update PR contract from current state",
    domain: "state",
    actor: "contract",
  },
  {
    name: "scout comments",
    parent: "scout",
    description: "Fetch PR review comments and threads",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout ci",
    parent: "scout",
    description: "Fetch remote CI status for a PR",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout checks",
    parent: "scout",
    description: "Fetch repo check configuration",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout logs",
    parent: "scout",
    description: "Fetch CI logs for a PR",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout status",
    parent: "scout",
    description: "Fetch repo and worktree status",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout overview",
    parent: "scout",
    description: "Fetch a repo overview snapshot",
    domain: "state",
    actor: "scout",
  },
  {
    name: "scout notion",
    parent: "scout",
    description: "Resolve a Notion page UUID/Task-ID to a structured mirror record",
    domain: "state",
    actor: "scout",
  },
  {
    // GH-232: the source FETCH — scout owns the gh/bd/notion reach. The pin
    // (intake) attenuates the result into <unit>:source@pinned downstream.
    name: "scout source",
    parent: "scout",
    description: "Resolve a work unit's source authority (GH/beads/Notion)",
    domain: "state",
    actor: "scout",
  },
  // GH-294: the signed-spawn ocap audit surface. The spawn attestation
  // (`<unit>:spawn@<role>`) binds a leg's launch to its consumed input material;
  // `verify` is read-only and confirms the signature + material freshness.
  {
    name: "spawn",
    description: "Signed SLSA spawn attestations — the ocap that gates leg launches",
    domain: "state",
    actor: "audit",
  },
  {
    name: "spawn verify",
    parent: "spawn",
    description: "Verify a leg's signed SLSA spawn attestation (signature + material)",
    domain: "state",
    actor: "audit",
  },

  // ─── Derive actor — Datalog derived-truth spike (GH-1768) ─────────────────
  //
  // Read-only planner-tier actor. Verbs query a Horn-clause evaluator
  // over projected facts (issue / branch / worktree / pr / ci / phase /
  // transition). Emits three observability events
  // (DERIVE_FACTS_PROJECTED, DERIVE_QUERY_RUN, DERIVE_TRACE_EMITTED) via
  // `src/machine/actors.ts`; no mutating verbs, no machine-event emits
  // beyond those three. Lives in the catalog only while the spike is
  // running — retro decides promote / discard / re-scope.
  {
    name: "derive",
    description: "Query Datalog-derived facts over projected state",
    domain: "state",
    actor: "derive",
  },
  {
    name: "derive ready",
    parent: "derive",
    description: "List ready units via the readiness rules",
    domain: "state",
    actor: "derive",
  },
  {
    name: "derive drift",
    parent: "derive",
    description: "List drifted chains and the violated invariant",
    domain: "state",
    actor: "derive",
  },
  {
    name: "derive eligible",
    parent: "derive",
    description: "List actors eligible to act on an issue",
    domain: "state",
    actor: "derive",
  },
  {
    name: "derive why",
    parent: "derive",
    description: "Print the provenance tree for a derived fact",
    domain: "state",
    actor: "derive",
  },
  {
    name: "derive dump-facts",
    parent: "derive",
    description: "Emit projected and derived facts as JSONL",
    domain: "state",
    actor: "derive",
  },

  // ─── Rules actor — claude/rules/*.md as build artifact (GH-1423 spike) ────
  //
  // The hand-authored `claude/rules/core.md` drifts from substrate: line
  // 96 advertises shell aliases (`za`, `zb`, `zc`) that no nix module in
  // this repo declares. The rules actor projects `claude/rules/*.md` from
  // typed inputs (verb-supply / alias-supply / worktree-gestures /
  // memory-index) and validates that backticked claims resolve. PR-1
  // wires verb-supply only; the other three loaders ship as typed stubs
  // so the renderer can be developed against a partial substrate
  // (`docs/prx/rules-build-substrate.md`).
  {
    name: "rules render",
    parent: "rules",
    description: "Render claude/rules/*.md from typed inputs",
    domain: "system",
    actor: "rules",
  },
  {
    name: "rules validate",
    parent: "rules",
    description: "Validate rules markdown against typed substrate",
    domain: "system",
    actor: "rules",
  },
  {
    name: "rules inputs",
    parent: "rules",
    description: "Dump typed inputs as JSON for debugging",
    domain: "system",
    actor: "rules",
  },

  // ─── Fetch actor — external→substrate refresh chokepoint (GH-1245 spike) ──
  //
  // Per `docs/fetch-actor-spike.md`, the v0 verb is per-source and
  // dry-run-only: it projects refresh cost from the current watermark and
  // returns a `go|skip|fail` decision without writing. Hard-true `dryRun`
  // at the schema layer enforces I-F1 (no writes in the spike). Post-spike
  // tickets (§12) ship the write path on top of this same actor.
  {
    name: "fetch",
    description: "Refresh substrate from external sources",
    domain: "state",
    actor: "fetch",
  },
  {
    name: "fetch gh-issues",
    parent: "fetch",
    description: "Project a GH-issues refresh cost; --dry-run only in spike",
    domain: "state",
    actor: "fetch",
  },

  // ─── Doctor actor — PR readiness diagnostics (GH-885 + GH-882) ────────────

  {
    name: "doctor",
    description: "Diagnose PR readiness, drive guarded transitions",
    domain: "work-units",
    binding: "work-unit",
    actor: "doctor",
  },
  {
    name: "doctor inventory",
    parent: "doctor",
    description: "Print typed PR snapshot with gate breakdown",
    domain: "work-units",
    binding: "work-unit",
    actor: "doctor",
  },
  {
    // GH-1559: the publication transition verbs moved to `publisher` per the
    // GH-1398 ADR §4 read/diagnose-vs-publish split. These stay one release
    // window as deprecation aliases that delegate to the publisher handler
    // (removed in the chain's #6 ticket).
    name: "doctor merge",
    parent: "doctor",
    description: "Deprecated alias for publisher merge",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "publisher merge",
      removal_target: "GH-1398 publisher chain (#6)",
      stderr_hint: "prx doctor merge is deprecated; use `prx publisher merge`.",
    },
    actor: "publisher",
  },
  {
    name: "doctor ready",
    parent: "doctor",
    description: "Deprecated alias for publisher ready",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "publisher ready",
      removal_target: "GH-1398 publisher chain (#6)",
      stderr_hint: "prx doctor ready is deprecated; use `prx publisher ready`.",
    },
    actor: "publisher",
  },
  {
    name: "doctor draft",
    parent: "doctor",
    description: "Deprecated alias for publisher draft",
    domain: "work-units",
    binding: "work-unit",
    deprecation: {
      alias_for: "publisher draft",
      removal_target: "GH-1398 publisher chain (#6)",
      stderr_hint: "prx doctor draft is deprecated; use `prx publisher draft`.",
    },
    actor: "publisher",
  },
  {
    // GH-1533: read-back over the unified audit sink.
    name: "doctor gh-budget",
    parent: "doctor",
    description: "Summarize recent gh GraphQL spend by verb",
    domain: "state",
    actor: "doctor",
  },
  {
    // GH-1508: ADR §6 substrate-tier dedupe verb. Closes duplicate bd
    // records pinned to the same (domain, external_id) and re-anchors
    // their dep edges onto the canonical record.
    name: "doctor dedupe-bd",
    parent: "doctor",
    description: "Close duplicate bd records per ADR §6",
    domain: "work-units",
    actor: "doctor",
  },

  // ─── Publisher actor — PR publication transitions (GH-1559 / GH-1398) ──────
  // The publication-transition verbs moved off `doctor` per the GH-1398 ADR §4
  // read/diagnose-vs-publish split. `publisher` owns `pr.merge|pr.ready|pr.draft`
  // in the machine actor catalog (GH-1558); these entries land the matching
  // CLI surface. `merge` is handoff-only at the executor allowlist layer.
  {
    name: "publisher",
    description: "Drive PR publication transitions through GitHub",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher merge",
    parent: "publisher",
    description: "Gate against I04, then enable automerge",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher ready",
    parent: "publisher",
    description: "Gate ci+threads, then mark PR ready for review",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher draft",
    parent: "publisher",
    description: "Convert PR back to draft (no gate)",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher pr",
    parent: "publisher",
    description: "Forge PR open update comment and edit verbs",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher pr open",
    parent: "publisher",
    description: "Open a PR (gh pr create), draft by default",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher pr update",
    parent: "publisher",
    description: "Update-branch (rebase onto base) and optionally retitle",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  // GH-2438 Rule 4 + ai-home-2ow2v: the `github` write surface is the forge
  // actor's. These wrap `gh pr comment` / `gh pr edit` so the author profile
  // reaches them via `prx author dispatch --actor=publisher -- pr <verb>`
  // instead of raw `gh` (headless, ocap-pure). Mark-ready/draft already live as
  // `publisher ready` / `publisher draft`; PR open as `publisher pr open`.
  {
    name: "publisher pr comment",
    parent: "publisher",
    description: "Post a review comment on the PR",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },
  {
    name: "publisher pr edit",
    parent: "publisher",
    description: "Edit the PR title or body",
    domain: "work-units",
    binding: "work-unit",
    actor: "publisher",
  },

  // ─── Keeper actor — git-write / ref custody (GH-2353 / GH-2348.3) ──────────
  // `keeper` owns push + branch ops, split out of `publisher` (now forge-only)
  // per the GH-2348 artifact-roles spike. Runs git through the git-safe wrapper
  // as role=keeper. GH-2381 added commit-materialization (write-tree at submit
  // stage, commit-tree at submit publish) — invoked in-process by the submit
  // pipeline via `runKeeperWriteTree` / `runKeeperCommitTree` (no operator CLI
  // sub-verb; not surfaced here).
  {
    name: "keeper",
    description: "Git-write and ref custody for a work unit",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
  },
  {
    name: "keeper push",
    parent: "keeper",
    description: "Push the work-unit branch to its remote (keeper role)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
  },
  {
    name: "keeper branch",
    parent: "keeper",
    description: "Create or update the work-unit branch ref (keeper role)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
  },
  {
    name: "keeper commit",
    parent: "keeper",
    description: "Headlessly stage and commit the worktree (keeper role; GH-2346)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
  },
  {
    // GH-201: `keeper serve` runs keeperd — the persistent git-write/signing
    // daemon — on a unix socket inside an isolated VM. Infrastructure verb, not
    // an operator command: `internal: true` keeps it out of the user-facing
    // help/plugin surfaces while still registering it as a real keeper verb.
    name: "keeper serve",
    parent: "keeper",
    description: "Run the keeperd git-write/signing daemon on a unix socket (keeper role; GH-201)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
    internal: true,
  },
  {
    // GH-201/223: `keeper up <vm>` deploys the Linux prx into the Lima VM and
    // starts keeperd detached (writing its own pidfile); `keeper down <vm>` stops
    // it by that pidfile. Host-side infrastructure verbs (run limactl),
    // `internal: true` like `serve`.
    name: "keeper up",
    parent: "keeper",
    description: "Deploy + start keeperd inside a Lima VM (keeper role; GH-201)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
    internal: true,
  },
  {
    name: "keeper down",
    parent: "keeper",
    description: "Stop keeperd inside a Lima VM (keeper role; GH-201)",
    domain: "work-units",
    binding: "work-unit",
    actor: "keeper",
    internal: true,
  },

  // ─── Lima — in-VM daemon lifecycle (keeper + beads); GH-228 ────────────────
  // Generalizes `keeper up|down` into one namespace over a daemon registry, so
  // the VM's daemons are brought up/down/inspected from one place.
  {
    name: "lima",
    description: "Manage in-VM daemons (keeper + beads) on a Lima VM",
    domain: "work-units",
    actor: "keeper",
  },
  {
    name: "lima up",
    parent: "lima",
    description: "Deploy + start in-VM daemon(s) on a Lima VM (--daemon keeper|beads|all)",
    domain: "work-units",
    actor: "keeper",
  },
  {
    name: "lima down",
    parent: "lima",
    description: "Stop in-VM daemon(s) on a Lima VM (--daemon keeper|beads|all)",
    domain: "work-units",
    actor: "keeper",
  },
  {
    name: "lima daemons",
    parent: "lima",
    description: "List the registered in-VM daemons and their default sockets",
    domain: "work-units",
    actor: "keeper",
  },
  {
    name: "lima status",
    parent: "lima",
    description: "Show which in-VM daemons are up on a Lima VM",
    domain: "work-units",
    actor: "keeper",
  },
  {
    // GH-296: install bd+dolt + clone canonical beads into the VM (beadsd source).
    name: "lima provision-beads",
    parent: "lima",
    description: "Install bd+dolt and clone canonical beads into a Lima VM (GH-296)",
    domain: "work-units",
    actor: "keeper",
  },

  // ─── Provenance — read-only signing-identity inspection (GH-2282) ──────────
  // `provenance dev-pubkey` prints (and bootstraps on first use) the persisted
  // dev signing identity that `PRX_PROVENANCE_KEY=dev` signs with. Owned by the
  // publisher actor (verification_publication tier; sits beneath it as the
  // env-gated signer seam, no new XState states). Read-only, no work-unit
  // binding — `binding` defaults to "none".
  {
    name: "provenance",
    description: "Inspect provenance signing identities (read-only)",
    domain: "state",
    actor: "publisher",
  },
  {
    name: "provenance dev-pubkey",
    parent: "provenance",
    description: "Print the persisted dev signing identity",
    domain: "state",
    actor: "publisher",
  },

  // ─── Audit actor — adherence metrics (GH-1823) ────────────────────────────
  // Three read-only verbs that measure whether the artifact graph
  // GH-1824 promises is actually being produced. `ingest` refreshes the
  // SQLite metrics store from NDJSON sinks + transition logs; `uow`
  // projects per-UoW artifact-chain status + I-AUD findings; `system`
  // rolls up the seven V1 metric views. No writes to bd / gh / git / wt.
  {
    name: "audit",
    description: "Measure architectural adherence across artifact graph",
    domain: "state",
    actor: "audit",
  },
  {
    name: "audit ingest",
    parent: "audit",
    description: "Refresh metrics store from audit sink and transitions",
    domain: "state",
    actor: "audit",
  },
  {
    name: "audit uow",
    parent: "audit",
    description: "Project per-UoW artifact chain and invariant findings",
    domain: "work-units",
    binding: "work-unit",
    actor: "audit",
  },
  {
    name: "scope-gate",
    description: "Gate a commit's diff against the plan's declared scope",
    domain: "work-units",
    actor: "scope-gate",
  },
  {
    name: "scope-gate run",
    parent: "scope-gate",
    description: "Check files_changed ⊆ plan.paths; emit a signed gate/v1 verdict",
    domain: "work-units",
    binding: "work-unit",
    actor: "scope-gate",
  },
  {
    name: "test-gate",
    description: "Run the checks the executor skipped, as a signed gate",
    domain: "work-units",
    actor: "test-gate",
  },
  {
    name: "test-gate run",
    parent: "test-gate",
    description: "Run typecheck + test on the commit; emit a signed gate/v1 verdict",
    domain: "work-units",
    binding: "work-unit",
    actor: "test-gate",
  },
  {
    name: "audit system",
    parent: "audit",
    description: "Roll up seven V1 metrics across the artifact graph",
    domain: "state",
    actor: "audit",
  },

  // ─── Services actor — external-plane status verbs (GH-1407) ───────────────
  // Read-only projector over `non-interactive-agent/usage` audit rows that
  // surfaces Anthropic prompt-cache hit rates per profile / actor /
  // workUnitId. The leading `--anthropic` plane is the only one wired
  // today; per-actor budget columns belong to GH-1826.
  {
    name: "services",
    description: "Inspect external service planes (Anthropic, …)",
    domain: "state",
    actor: "services",
  },
  {
    name: "services status",
    parent: "services",
    description: "Project cache hit rate from non-interactive-agent usage rows",
    domain: "state",
    actor: "services",
  },

  // ─── submit.* leaves (GH-1318) ─────────────────────────────────────────────
  // PR-title `(GH-N)` suffix is decorative, not a GitHub close-keyword, so
  // bundled and single-target prx PRs leak open issues on merge. The submit
  // actor closes that gap with a pre-merge emitter and a post-merge sweep.
  {
    name: "submit body-template",
    parent: "submit",
    description: "Render PR body with Closes/Refs lines per unit",
    domain: "work-units",
    binding: "work-unit",
    actor: "submit",
  },
  {
    name: "submit postmerge",
    parent: "submit",
    description: "Sweep merged PR body, close referenced units missed",
    domain: "work-units",
    binding: "work-unit",
    actor: "submit",
  },
  {
    // GH-2262: producer of the work-unit-bound submit artifact. Resolves git
    // state into `<UoW>:submit@<slot>` in the submit CAS domain — the ref the
    // `publish` consumer reads. Closes the GH-1900 gap (no artifact producer).
    name: "submit stage",
    parent: "submit",
    description: "Stage git state into a CAS submit artifact (publish producer)",
    domain: "work-units",
    binding: "work-unit",
    actor: "submit",
  },
  {
    // GH-1900: consumer of the work-unit-bound submit-session artifact.
    // Reads `<UoW>:submit@<slot>` from the submit CAS domain, runs the
    // parity preflight, pushes the head branch, opens the PR, and advances
    // the ref to `:submit@published`.
    name: "submit publish",
    parent: "submit",
    description: "Publish a CAS-backed submit artifact (push + gh pr create)",
    domain: "work-units",
    binding: "work-unit",
    actor: "submit",
  },

  // ─── Dep-research routine (GH-1261) ────────────────────────────────────────

  {
    name: "dep",
    description: "Periodically research upstream deps",
    domain: "state",
    actor: "work",
  },
  {
    name: "dep manifest",
    parent: "dep",
    description: "Print resolved dep-research manifest",
    domain: "state",
    actor: "work",
  },
  {
    name: "dep research",
    parent: "dep",
    description: "Snapshot upstream dep paths into .prx/dep-research/",
    domain: "state",
    actor: "work",
  },
  {
    name: "dep status",
    parent: "dep",
    description: "Inspect last-run + classification per dep (read-only)",
    domain: "state",
    actor: "work",
  },

  // ─── Repo plumbing ─────────────────────────────────────────────────────────

  {
    name: "repo add",
    parent: "repo",
    description: "Clone bare repo and bootstrap detached mainx",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    // GH-1760: register an existing on-disk worktree's owning bare in the
    // prx-wide sqlite registry. Read-only git inference + idempotent upsert.
    name: "repo adopt",
    parent: "repo",
    description: "Adopt on-disk worktree into prx registry",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    // GH-1761: register the current branch of an on-disk worktree in the
    // prx registry. Requires the owning repo to be adopted first.
    name: "branch adopt",
    parent: "branch",
    description: "Adopt current branch into prx registry",
    domain: "repo-plumbing",
    actor: "branch",
  },
  {
    // GH-1762: register the on-disk worktree in the prx registry. Auto-chains
    // `repo adopt` + `branch adopt` (idempotent). Produces the workspace_id
    // every downstream adopt-flow verb keys off.
    name: "workspace adopt",
    parent: "workspace",
    description: "Adopt on-disk worktree into prx registry",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  // GH-1978: workspace lifecycle actor verbs. Drivers (worktrunk today;
  // devcontainer / nix devShell / CI pre-job tomorrow) call into the actor
  // only through these. Retires wtctl's sync/ignore sync/up/down surface.
  {
    name: "workspace reserve",
    parent: "workspace",
    description: "Reserve a workspace branch (idempotent ensure-branch)",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    // prx-997: materialize the reserved branch's worktree on disk — the step
    // between reserve and prepare in the workspace lifecycle.
    name: "workspace materialize",
    parent: "workspace",
    description: "Materialize the reserved workspace worktree on disk",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    name: "workspace prepare",
    parent: "workspace",
    description: "Prepare workspace tooling files for a lifecycle phase",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    name: "workspace sync",
    parent: "workspace",
    description: "Idempotently re-apply workspace tooling-file drift correction",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    name: "workspace service",
    parent: "workspace",
    description: "Start or stop workspace compose services (--auto = no-op without profile)",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    name: "workspace teardown",
    parent: "workspace",
    description: "Mark the workspace torn down (closes lifecycle ledger)",
    domain: "repo-plumbing",
    actor: "workspace",
  },
  {
    name: "repo backfill",
    parent: "repo",
    description: "Populate bd_workspace_prefix on stale inventory entries (GH-1722)",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo add-dolthub",
    parent: "repo",
    description: "Wire a Dolthub remote on a per-project beads workspace (GH-1703)",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo bootstrap",
    parent: "repo",
    description: "Bootstrap per-project .beads/ and wire Dolthub on a beads-less repo (GH-1704)",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo list",
    parent: "repo",
    description: "List prx-managed repositories across hosts",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo local",
    parent: "repo",
    description: "List repos cloned under HOME",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo normalize",
    parent: "repo",
    description: "Normalize repo names against canonical config",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo materialize",
    parent: "repo",
    description: "Clone or fetch a registered bare repo idempotently",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo overview",
    parent: "repo",
    description: "Print repo overview snapshot (accepts optional <slug> positional; falls back to cwd)",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo status",
    parent: "repo",
    description: "Print repo status with git details",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo checks",
    parent: "repo",
    description: "Show repo branch protection checks",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo sync-issues",
    parent: "repo",
    description: "Sync repo issue state from GitHub",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo sync-status",
    parent: "repo",
    description: "Sync repo status state from GitHub",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo protect-main",
    parent: "repo",
    description: "Apply branch protection to main",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo ci",
    parent: "repo",
    description: "Fetch remote CI summary for a PR",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "repo pr-comments",
    parent: "repo",
    description: "List or resolve PR review threads",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    // GH-1710 / GH-2013: flip a per-repo axis on an existing inventory entry.
    name: "repo set",
    parent: "repo",
    description: "Set a per-repo axis (canonical, stale-threshold-days, bd-workspace-prefix, dolt-remote)",
    domain: "repo-plumbing",
    actor: "repo",
  },
  {
    name: "worktree list",
    parent: "worktree",
    description: "List worktrees with status flags",
    domain: "repo-plumbing",
    actor: "worktree",
  },
  {
    name: "worktree status",
    parent: "worktree",
    description: "Show single worktree status",
    domain: "repo-plumbing",
    actor: "worktree",
  },
  {
    // GH-983: filter-aware portfolio picker. Supersedes the retired
    // `worktree next` verb (which was a GH-1510 deprecation alias for
    // `prx next`). Sibling of `prx next` — `next` dumps the full
    // eight-thread projection; `delegate next` returns a top-1 pick
    // (default) or filtered list (`--all`) with `--epic | --area |
    // --priority | --type` filters.
    name: "delegate next",
    parent: "delegate",
    description: "Pick top portfolio candidate to delegate",
    domain: "work-units",
    actor: "delegate",
  },
  {
    // GH-1874: bd-canonical assignment verb. Writes bd's `assignee` column
    // via `bd assign`; the bd→GH mirror's `push()` projects it onto the
    // issue on the next sync cadence. Sibling of `delegate next`.
    name: "delegate assign",
    parent: "delegate",
    description:
      "Assign a work unit to an agent (bd-canonical; mirror projects to GH)",
    domain: "work-units",
    actor: "delegate",
  },
  {
    // GH-2012: one-time repair pass for bd records whose assignee column is a
    // display-name string (legacy `git config user.name` resolver behavior),
    // rewriting them to the operator-supplied GH login. Default --dry-run;
    // --apply writes via `bd assign`.
    name: "delegate repair-assignees",
    parent: "delegate",
    description:
      "List or rewrite bd records with non-GH-login assignees",
    domain: "work-units",
    actor: "delegate",
  },
  {
    name: "worktree remove",
    parent: "worktree",
    description: "Remove a worktree and branch",
    domain: "repo-plumbing",
    actor: "worktree",
  },
  {
    // GH-1166: canonical home for `prx session refresh` after the bare-session
    // namespace retired. Same handler — rebases the work-unit branch onto
    // origin/main with conflict reporting.
    name: "worktree refresh",
    parent: "worktree",
    description: "Rebase work-unit branch onto origin main",
    domain: "repo-plumbing",
    binding: "work-unit",
    actor: "worktree",
  },
  {
    name: "beads hydrate",
    parent: "beads",
    description: "Hydrate beads database for current repo",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    // GH-296: host twin of `prx lima provision-beads` — clone canonical beads
    // into the well-known local path so the local daemon serves one healthy DB.
    name: "beads provision",
    parent: "beads",
    description: "Provision the canonical local beads clone",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads issue",
    parent: "beads",
    description: "Look up beads row by GitHub issue",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    // GH-1706: one-call embedded → shared-server migration. Sister verbs
    // `prx repo add-dolthub` (GH-1703) and `prx repo gc` (GH-1700) handle
    // remote wiring + orphan sweep separately.
    name: "beads migrate",
    parent: "beads",
    description: "Migrate a registered repo's beads from embedded to shared-server",
    domain: "state",
    actor: "beads",
  },
  {
    // GH-1507: single-record bd→GH mirror push. Sibling of `intake mirror`
    // (GH→bd); the canonical per-record reverse-orphan publish verb
    // (GH-1718 retired the prior `triage push-orphans` sweep).
    name: "beads publish",
    parent: "beads",
    description: "Publish a beads record to GitHub (bd→GH mirror)",
    domain: "work-units",
    binding: "mainx",
    actor: "beads",
  },
  {
    // GH-1990: alias of `prx sync issues --from gh --to bd`. Retained so
    // existing consumers/scripts keep working; agents and operators should
    // name the canonical surface (`prx sync issues …`). Removal is a
    // follow-up once consumers migrate.
    //
    // GH-2095: reconciles pinned (bd, <domain>) pairs.
    //   pull leg (external → bd): status — close-applies via bd close.
    //   push leg (bd → external): title, body, assignee.
    //   --limit caps push only; pull runs over every pinned pair.
    //   exit 2 + stderr WARN when any pair is left non-reconciled.
    // The CommandSpec.description field is constrained to 4-12 words
    // (help-surface §6.4) — the long-form contract above is the source of
    // truth, the description below is the help-table summary.
    name: "beads sync",
    parent: "beads",
    description: "Alias of sync issues; --limit caps push only",
    domain: "state",
    actor: "beads",
  },
  {
    // GH-1702: cross-repo fan-out of `prx dolt reconcile` across every
    // dolthub-wired registered bare repo. Lands under the `beads` parent
    // per the issue title and original spec; the GH-2009 forward
    // declaration at `dolt sync-all` remains for the eventual canonical
    // surface migration. Actor is `dolt` because the per-repo primitive
    // and the new DOLT_SYNC_* emits are dolt-actor events.
    name: "beads sync-all",
    parent: "beads",
    description: "Fan out prx dolt reconcile across dolthub-wired registered repos",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    // GH-228: `beads serve` runs beadsd — the read-only beads query daemon — on
    // a unix socket inside an isolated VM. In-VM infrastructure verb (the host
    // reaches it via the Lima channel), `internal: true` like `keeper serve`.
    name: "beads serve",
    parent: "beads",
    description: "Run the beadsd read daemon on a unix socket (GH-228)",
    domain: "repo-plumbing",
    actor: "beads",
    internal: true,
  },
  {
    // GH-228: operator self-heal for an unhealthy beads clone (missing prefix /
    // diverged after the canonical prefix repair). Visible — agents/operators run it.
    name: "beads doctor",
    parent: "beads",
    description: "Diagnose the beads workspace; --fix re-bootstraps an unhealthy clone (GH-228)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    // GH-296: the read door — query beads through the in-VM beadsd daemon (no
    // host beads DB). The human + agents reach beads through one source.
    name: "beads ready",
    parent: "beads",
    description: "Ready issues via the in-VM beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads list",
    parent: "beads",
    description: "List issues via the in-VM beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads show",
    parent: "beads",
    description: "Show one issue via the in-VM beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    // GH-296 wave 2: the write door — single-writer, routed through beadsd.
    name: "beads create",
    parent: "beads",
    description: "Create an issue via the beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads update",
    parent: "beads",
    description: "Update an issue via the beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads close",
    parent: "beads",
    description: "Close an issue via the beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    name: "beads reopen",
    parent: "beads",
    description: "Reopen a closed issue via the beadsd daemon (GH-296)",
    domain: "repo-plumbing",
    actor: "beads",
  },
  {
    // GH-1990: canonical actor surface for bd↔external reconcile. Operators
    // and agents must reach reconcile flows through this verb family rather
    // than raw `bd <verb>` / `git <verb>`. Per-pair work lives under
    // `sync issues` (and future siblings); the parent exists so help-surface
    // §6 grouping has a stable home.
    name: "sync",
    description: "Canonical actor surface for issue reconcile",
    domain: "state",
    actor: "domain_sync",
  },
  {
    // GH-1990: directional issue sync (--from <src> --to <dst>). This PR
    // wires `--from gh --to bd` only and delegates to
    // `runBdGithubSyncPullOnly` (the same path `prx beads sync` and the
    // triage chain already use). Reverse direction and additional pairs
    // (notion, etc.) are deferred to follow-ups under this actor.
    //
    // GH-2095: reconciles pinned (bd, <domain>) pairs.
    //   pull leg (external → bd): status — close-applies via bd close.
    //   push leg (bd → external): title, body, assignee.
    //   --limit caps push only; pull runs over every pinned pair.
    //   exit 2 + stderr WARN when any pair is left non-reconciled.
    // The CommandSpec.description field is constrained to 4-12 words
    // (help-surface §6.4) — the long-form contract above is the source of
    // truth, the description below is the help-table summary.
    name: "sync issues",
    parent: "sync",
    description: "Reconcile pinned pairs; --limit caps push only",
    domain: "state",
    actor: "domain_sync",
  },
  {
    // GH-1469: range-backfill of cursor-skipped external records (GH-1500
    // authority ADR §5). Enumerates external records over `--from N --to M`,
    // resolves each via the (domain, external_id) map, and mirrors the
    // unmatched ones through the canonical single-record path
    // (`runIntakeMirror`). Heals records the forward-only `bd github sync`
    // cursor passed without importing (the GH-1462 incident); the substrate
    // resolver fix is GH-1479 (open, upstream gastownhall/beads; GH-1473 only
    // contained it prx-side). Never advances the fetch watermark (I-BF3).
    // Sibling of `sync issues`; gh-only in the first cut.
    name: "sync backfill",
    parent: "sync",
    description: "Backfill cursor-skipped external records over a range",
    domain: "state",
    actor: "domain_sync",
  },
  {
    // GH-1513: bd-side memory-decay policy (GH-1500 ADR §3b; capability
    // split 4/4 of GH-298). Operator-triggered tick that classifies closed
    // bd records and hands eligible ids to `bd admin compact --auto`.
    name: "memory compact",
    parent: "memory",
    description: "Compact closed beads (memory-decay policy chokepoint)",
    domain: "state",
    actor: "memory",
  },
  // GH-1397: structured handoff queue verbs. Plumbing under every actor —
  // a harness-denied verb in any session lands as a typed envelope routed to
  // the recipient actor (publisher / triage / submit / author). v0 ships
  // a single `noop` adapter for end-to-end coverage; real adapters land in
  // their own tickets (GH-1564 publisher, etc.).
  {
    name: "handoff enqueue",
    parent: "handoff",
    description: "Enqueue a handoff for the recipient actor",
    domain: "state",
    actor: "handoff",
  },
  {
    name: "handoff status",
    parent: "handoff",
    description: "Show pending handoffs filtered by target",
    domain: "state",
    actor: "handoff",
  },
  {
    name: "handoff drain",
    parent: "handoff",
    description: "Drain pending handoffs for one recipient",
    domain: "state",
    actor: "handoff",
  },
  {
    name: "handoff replay",
    parent: "handoff",
    description: "Re-enqueue an abandoned or failed row",
    domain: "state",
    actor: "handoff",
  },
  {
    // GH-1495: temporal→durable memory digest. Drives the per-run
    // `transcriptsDigestMachine` (src/transcripts-digest/machine.ts).
    // Three modes (`--dry-run`, `--stage`, `--commit`) gated by flags
    // per the user direction on the output-target question.
    name: "transcripts digest",
    parent: "transcripts",
    description: "Digest transcripts into durable memory shards",
    domain: "state",
    actor: "transcripts",
  },
  {
    // GH-1495: TTL pressure + staged-candidate counts across known sources.
    // Read-only; mirrors the `derive` actor's no-mutating-verb stance.
    name: "transcripts status",
    parent: "transcripts",
    description: "Report transcript TTL pressure and candidates",
    domain: "state",
    actor: "transcripts",
  },
  {
    // GH-1495: introspect the source-adapter registry. v0 ships two adapters
    // (claude-code-jsonl, claude-web-export); future Codex/ChatGPT/Gemini
    // adapters surface here when registered.
    name: "transcripts list-sources",
    parent: "transcripts",
    description: "List registered transcript source adapters",
    domain: "system",
    actor: "transcripts",
  },
  {
    name: "tools wt",
    parent: "tools",
    description: "Wrap worktrunk wt with policy enforcement",
    domain: "repo-plumbing",
    actor: "tools",
  },
  {
    name: "tools git",
    parent: "tools",
    description: "Wrap git with policy enforcement",
    domain: "repo-plumbing",
    actor: "tools",
  },
  {
    name: "tools bd",
    parent: "tools",
    description: "Wrap beads CLI with policy enforcement",
    domain: "repo-plumbing",
    actor: "tools",
  },
  {
    name: "tools labels sync",
    parent: "tools",
    description: "Sync triage label vocab onto GitHub",
    domain: "repo-plumbing",
    actor: "tools",
  },
  // GH-2009: dolt lifecycle actor verbs. Owns the provisioned →
  // running ⇄ healthy → stopped → orphaned graph for a per-repo dolt
  // sql-server. The pre-existing `dolt reconcile` row already named
  // `actor: "dolt"`; this section adds the remaining eight verbs as
  // declarations only. Routing into the dolt actor runtime lands in
  // re-shaped child tickets (GH-555, GH-557, GH-568, GH-1685,
  // GH-1938; GH-1702 stays on its existing shape). `prx tools dolt`
  // is rejected because GH-1934 retires the `prx tools` namespace.
  {
    name: "dolt provision",
    parent: "dolt",
    description: "Provision per-repo dolt database and initial push (GH-1685)",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt start",
    parent: "dolt",
    description: "Start prx-owned dolt sql-server for this repo",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt stop",
    parent: "dolt",
    description: "Stop prx-owned dolt sql-server for this repo",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt status",
    parent: "dolt",
    description: "Report dolt sql-server lifecycle and health",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt adopt",
    parent: "dolt",
    description: "Adopt an external dolt sql-server pid (legacy import)",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt reconcile",
    parent: "dolt",
    description: "Reconcile dolt push, optionally resolving schema conflicts",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt sync-all",
    parent: "dolt",
    description: "Fan-out reconcile over every managed dolt database (GH-1702)",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt policy",
    parent: "dolt",
    description: "Set dolt.auto-push or dolt.auto-commit across managed workspaces",
    domain: "repo-plumbing",
    actor: "dolt",
  },
  {
    name: "dolt supervise",
    parent: "dolt",
    description: "Enable cross-session dolt supervisor (Darwin launchd, GH-568)",
    domain: "repo-plumbing",
    actor: "dolt",
  },

  // prx-wt5: merge-conflict reconciliation actor (mediator). Read-only v0
  // verbs — detect/classify/status — that write nothing to the working tree
  // (I-MED1). They route to `mediator-stub` today; the detector orchestrator
  // that wires them lands under the prx-wt5 epic.
  {
    name: "mediator detect",
    parent: "mediator",
    description: "Detect conflicted paths in an in-progress rebase",
    domain: "repo-plumbing",
    actor: "mediator",
  },
  {
    name: "mediator classify",
    parent: "mediator",
    description: "Classify each detected merge conflict by kind",
    domain: "repo-plumbing",
    actor: "mediator",
  },
  {
    name: "mediator status",
    parent: "mediator",
    description: "Report the merge-conflict reconciliation lifecycle state",
    domain: "repo-plumbing",
    actor: "mediator",
  },

  // ─── System ────────────────────────────────────────────────────────────────

  {
    name: "home update",
    parent: "home",
    description: "Run nix flake update plus home-manager switch",
    domain: "system",
    actor: "home",
  },
  {
    // prx-1ab: one-command self-update — `prx upgrade` updates the `prx` flake
    // input, commits the lockfile, and runs home-manager switch. (Distinct from
    // `prx update`, the PR-contract render/update.)
    name: "upgrade",
    description: "Self-update: nix flake update prx + commit lockfile + home-manager switch",
    domain: "system",
    actor: "home",
  },
  {
    name: "home sync",
    parent: "home",
    description: "Detach origin main then run home update",
    domain: "system",
    actor: "home",
  },
  {
    name: "hooks apply",
    parent: "hooks",
    description: "Apply prx-managed git hooks across repos",
    domain: "system",
    actor: "hooks",
  },
  {
    name: "hooks status",
    parent: "hooks",
    description: "Report git hooks path drift",
    domain: "system",
    actor: "hooks",
  },
  {
    name: "preflight claude",
    parent: "preflight",
    description: "Verify claude agent runtime dependencies",
    domain: "system",
    actor: "preflight",
  },
  {
    name: "preflight notion",
    parent: "preflight",
    description: "Verify notion MCP runtime dependencies",
    domain: "system",
    actor: "preflight",
  },
  {
    name: "run profile",
    parent: "run",
    description: "Print runtime profile projection",
    domain: "system",
    actor: "work",
  },
  {
    name: "run smoke",
    parent: "run",
    description: "Smoke-test agent runtime for a unit",
    domain: "system",
    actor: "work",
  },
  {
    name: "run desktop",
    parent: "run",
    description: "Open worktree in Codex Desktop",
    domain: "system",
    actor: "work",
  },
  {
    name: "run task",
    parent: "run",
    description: "Run a task spec across roles",
    domain: "system",
    actor: "work",
  },
  {
    name: "init",
    description: "Scaffold cross-agent convention layer (AGENTS.md + project Claude settings)",
    domain: "system",
    actor: "init",
  },
  {
    name: "--version",
    description: "Print prx CLI version",
    domain: "system",
    actor: "tools",
  },

  // ─── Root oddities (#967 / #978 audit pending) ─────────────────────────────

  {
    name: "sprint",
    description: "Sprint init bind metric status sync",
    domain: "system",
    internal: true,
    actor: "tools",
  },
  {
    name: "task",
    description: "Task spec sync status run graph",
    domain: "system",
    internal: true,
    actor: "tools",
  },
  {
    name: "role",
    description: "Role start complete fail for a task",
    domain: "system",
    internal: true,
    actor: "tools",
  },
  {
    name: "spec",
    description: "Task spec init show validate operations",
    domain: "system",
    internal: true,
    actor: "tools",
  },
];

export const prxCommandRegistry: CommandSpec[] = z
  .array(CommandSpec)
  .parse(RAW_REGISTRY);

/** Lookup by canonical name (e.g., "plan session", "session close"). */
export function findCommand(name: string): CommandSpec | undefined {
  return prxCommandRegistry.find((c) => c.name === name);
}

/** Filter promoted commands for a session context (§6.2). */
export function promotedFor(ctx: SessionContext): CommandSpec[] {
  return prxCommandRegistry.filter(
    (c) => c.promoted_in.includes(ctx) && !c.deprecation,
  );
}

/** All entries owned by a given actor (GH-1242 PR-3+ dispatcher / help-actor ergonomics). */
export function commandsByActor(actor: ActorName): CommandSpec[] {
  return prxCommandRegistry.filter((c) => c.actor === actor);
}

// ── ActorSpec registry (GH-1530 object-capability substrate) ────────────────
//
// The TARGET-owned inbound capability registry. Each entry declares which
// source actors may dispatch TO that target (`allowedCallers`) — the ocap flip
// from the caller-authoritative `SESSION_PROFILES[...].allowedDispatchTargets`
// (outbound) to a target-owned inbound list. `canDispatch` consumes this via
// dependency injection: the dispatch handler resolves
// `actorSpecFor(target).allowedCallers` and passes it as `allowedCallers`,
// mirroring how it already injects the caller-side `allowedTargets`.
//
// `allowedCallers` is the INVERSE of the intended per-source outbound dispatch
// map, so it is a superset of the edges `defaultDispatchCapabilities` enforces
// today (every current source→target edge has its source listed under the
// target here). During the dual-gate migration (GH-1530 PR-5) a dispatch is
// admitted only when the source appears in BOTH the caller's outbound list AND
// the target's `allowedCallers`, so listing the broader intended inbound set
// here cannot widen the live policy — it only sets up the PR-6 loosening to a
// target-authoritative gate.
//
// Only dispatchable targets are listed; every other actor resolves via
// `actorSpecFor` to a frozen `{ dispatchable: false, allowedCallers: [] }`
// default (deny-by-default: a non-dispatchable target admits no caller).
const RAW_ACTOR_SPECS: z.input<typeof ActorSpec>[] = [
  // GH-1386: dispatch-only read substrate — every session profile reaches it
  // for file/grep/diff inventory that returns a `scout://sha256:<hex>` handle.
  { name: "scout", dispatchable: true, allowedCallers: ["plan", "triage", "intake", "implement", "submit", "author"] },
  // implement→plan exists today (defaultDispatchCapabilities.implement); submit
  // and author reach the saved plan slot under the intended ocap map.
  { name: "plan", dispatchable: true, allowedCallers: ["implement", "submit", "author"] },
  { name: "model", dispatchable: true, allowedCallers: ["plan"] },
  { name: "chain", dispatchable: true, allowedCallers: ["plan"] },
  { name: "contract", dispatchable: true, allowedCallers: ["plan", "author"] },
  { name: "worktree", dispatchable: true, allowedCallers: ["plan"] },
  { name: "delegate", dispatchable: true, allowedCallers: ["plan"] },
  { name: "repo", dispatchable: true, allowedCallers: ["plan", "author"] },
  { name: "beads", dispatchable: true, allowedCallers: ["plan"] },
  { name: "triage", dispatchable: true, allowedCallers: ["plan"] },
  { name: "submit", dispatchable: true, allowedCallers: ["plan", "implement", "author"] },
  { name: "work", dispatchable: true, allowedCallers: ["plan"] },
  { name: "tools", dispatchable: true, allowedCallers: ["plan", "implement"] },
  { name: "doctor", dispatchable: true, allowedCallers: ["implement"] },
  { name: "publisher", dispatchable: true, allowedCallers: ["implement", "author"] },
  { name: "intake", dispatchable: true, allowedCallers: ["triage"] },
];

export const prxActorRegistry: ActorSpec[] = z
  .array(ActorSpec)
  .parse(RAW_ACTOR_SPECS);

const actorSpecByName: ReadonlyMap<ActorName, ActorSpec> = new Map(
  prxActorRegistry.map((spec) => [spec.name, spec]),
);

/**
 * Resolve the ActorSpec for a target actor. Actors absent from
 * `RAW_ACTOR_SPECS` resolve to a deny-by-default spec
 * (`dispatchable: false`, `allowedCallers: []`) so every caller is rejected.
 */
export function actorSpecFor(name: ActorName): ActorSpec {
  return (
    actorSpecByName.get(name) ?? {
      name,
      dispatchable: false,
      allowedCallers: [],
    }
  );
}
