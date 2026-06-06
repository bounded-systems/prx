import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv } from "@bounded-systems/env";

import { PlanStoreError, resolvePlanStagingDirForDisplay } from "../plan-store/cas.ts";

/**
 * GH-188: turn on Claude Code OTel telemetry for a headless agent leg when an
 * OTLP collector is configured (`OTEL_EXPORTER_OTLP_ENDPOINT` in the host env).
 * Claude Code exports metrics + log events (and beta traces) — tagged here with
 * the prx actor so a fleet dashboard segments by actor. OTLP ONLY: the `console`
 * exporter writes to stdout, which the Agent SDK uses as its message channel, so
 * console would corrupt the leg's output — we never fall back to it. No endpoint
 * (or `PRX_OTEL_DISABLE=1`) ⇒ telemetry stays off, a safe no-op. Inherited env
 * is merged by the runtime, so existing `OTEL_*` host vars (protocol, headers,
 * resource attrs) pass through unchanged.
 */
export function agentOtelEnv(role: string): Record<string, string> {
  if (getEnv("PRX_OTEL_DISABLE") === "1") return {};
  if (!getEnv("OTEL_EXPORTER_OTLP_ENDPOINT")) return {};
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    // GH-188: traces are Claude Code beta (gated by CLAUDE_CODE_ENHANCED_TELEMETRY_BETA),
    // but they are what a trace UI like Jaeger actually renders — so enable them
    // too once a collector is configured, lighting up the telemetry actor's
    // backend with per-leg spans. `PRX_OTEL_TRACES=0` opts back out (metrics+logs only).
    ...(getEnv("PRX_OTEL_TRACES") === "0"
      ? {}
      : { OTEL_TRACES_EXPORTER: "otlp", CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1" }),
    OTEL_EXPORTER_OTLP_PROTOCOL: getEnv("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "http/protobuf",
    OTEL_SERVICE_NAME: getEnv("OTEL_SERVICE_NAME") ?? "prx",
    OTEL_RESOURCE_ATTRIBUTES: `service.name=prx,prx.actor=${role}`,
  };
}
import {
  type ArgComponent,
  assertArgvWithinCeiling,
} from "./argv_size.ts";
import { actorRuleset } from "./actor_ruleset.ts";
import { claudeSupportsSystemPromptFile } from "./claude_capabilities.ts";
import {
  type DispatchActor,
  defaultDispatchCapabilities,
} from "./dispatch.ts";

export const runtimeProfiles = ["work-unit", "user"] as const;
export type RuntimeProfileName = (typeof runtimeProfiles)[number];

export const runtimeIoFormats = ["json", "stream-json"] as const;
export type RuntimeIoFormat = (typeof runtimeIoFormats)[number];
export const runtimeModes = ["full", "dev"] as const;
export type RuntimeMode = (typeof runtimeModes)[number];
export const workAgentImplementations = ["claude", "codex", "copilot", "gemini", "cursor"] as const;
export type WorkAgentImplementation = (typeof workAgentImplementations)[number];
// GH-1822 widens this enum with four management roles (map, delegate,
// report, retro) so the Scrum-fit lifecycle axis has named role-axis
// agents to compose into. They are pure planning/management roles, not
// session profiles, so they ride the smaller-blast-radius taskAgentRoles
// list rather than sessionProfileNames. AgentContracts for the new roles
// live in `src/machine/contracts/instances.ts`; `buildAllowedToolsForRole`
// falls through to the read/Bash default for any non-{planner, executor,
// tester} role, which already covers the management roles.
export const taskAgentRoles = [
  "planner",
  "executor",
  "tester",
  "scout",
  "reviewer",
  "map",
  "delegate",
  "report",
  "retro",
  // GH-2326: gc (unified housekeeping) is a role spec — headless-first, with
  // the option to run as an agent session — NOT a SESSION_PROFILES entry
  // (operator steer 2026-05-27). It rides the smaller-blast-radius
  // taskAgentRoles path: a typed uow→gc_report AgentContract
  // (src/machine/contracts/instances.ts) is the headless agent; the
  // capability-gated CLI verbs (GH-2327) are the primary surface. The
  // destructive authority boundary is the explicit GC_DELETE_CAPABILITY token
  // + mark→sweep contract in src/machine/gc/capability.ts, not an ambient
  // session-profile toolset.
  "gc",
] as const;
export type TaskAgentRole = (typeof taskAgentRoles)[number];

export const sessionProfileNames = ["plan", "intake", "triage", "implement", "submit", "author", "scratch"] as const;
export type SessionProfileName = (typeof sessionProfileNames)[number];

/**
 * Machine-readable session-profile config (GH-950). Each session profile
 * (plan, intake, triage) is declared here as data — not embedded in prompt
 * strings — so the allowlist survives Claude version bumps and can be
 * inspected by the runtime, the prompt builders, and tests from a single
 * source of truth.
 */
export type SessionProfileConfig = {
  name: SessionProfileName;
  binding: "work-unit" | "mainx";
  banner: string;
  allowedTools: string[];
  disallowedTools: string[];
  allowedActors: string[];
  disallowedActors: string[];
  /**
   * GH-1194: dispatch capability whitelist. Per-source list of dispatch
   * targets reachable via `prx <source> dispatch --actor=<target> -- <verb>`.
   * Mirrors `defaultDispatchCapabilities` in src/machine/dispatch.ts; this
   * field is the inspectable source of truth for session profiles.
   */
  allowedDispatchTargets: DispatchActor[];
  /**
   * GH-2418: per-profile flip for the typed-dispatch (OCAP) gate. When `true`,
   * dispatch from this source is denied unless the request presents an
   * `inputArtifact` whose `type` matches the target's
   * `AgentContract.inputArtifact` — capability is artifact possession, not a
   * role-name. Absent/`false` means the source falls back to the global
   * `PRX_TYPED_DISPATCH_REJECTION` env flag (default off, backwards-compatible).
   * Flipped on for `implement` only in this spike (GH-1821 intent).
   */
  typedDispatchRejection?: boolean;
};

export const SESSION_PROFILES: Record<SessionProfileName, SessionProfileConfig> = {
  plan: {
    name: "plan",
    binding: "work-unit",
    banner:
      "prx plan session — read/search/inspect only. Top-level reads (next, phase, snapshot, statusline, actions) run directly; cross-actor reads go through `prx plan dispatch --actor=<target> -- <verb>` (model, scout, chain, contract, repo, worktree, delegate, beads, triage, submit — each returns a CAS handle you dereference, not direct stdout). Edit/Write and raw git/gh/bd are disabled at the toolset layer; exit and re-enter via `prx implement agent <GH-N>` from a fresh shell to ratchet into the executor toolset.",
    // GH-1147: allowlist consolidates onto prx verbs (the single operator
    // surface — see ai-home memory `feedback_prx_unified_surface`). Raw
    // git/gh/bd/wt are reachable only through the policy-enforcing
    // `prx tools <cli>` wrappers; everything else uses native prx verbs.
    // GH-1166: bare-session reads retired; canonical homes are top-level
    // (next/phase/snapshot/statusline/actions) or chain-namespaced.
    // GH-1530 (object-capability redesign): the plan profile's allow/deny is
    // now registry-derived via `actorRuleset("plan", …)` rather than a
    // hand-listed array. The own `prx plan:*` namespace is the registry glob
    // (so any new `prx plan <verb>` is runnable with zero edits here); base
    // reads are the reader toolset; raw gh/bd/git + search shells are the
    // shared deny.
    //
    // GH-1175: the planner never edits in place, but bare `Write` must NOT be
    // denied — `buildOpsPlanClaudeRuntimeProfile` injects a path-scoped
    // `Write(<staging>/**)` carve-out at runtime, and a bare-`Write` deny would
    // shadow it (a strict allowlist already denies bare `Write` by omission).
    // So `denyWrite: false`; `Edit` stays denied (reader default).
    //
    // GH-1530 PR-6 (target-authoritative ocap flip): every cross-namespace
    // `prx <actor> <verb>` read the planner used to run directly — model,
    // scout, chain, contract, worktree, delegate, repo, beads, triage, submit —
    // is now reached via `prx plan dispatch --actor=<target> -- <verb>` (covered
    // by the own `Bash(prx plan:*)` glob; the result is a CAS handle the planner
    // dereferences). Each target's `allowedCallers` admits `plan`, so the flip
    // (slice A) makes those dispatches admissible without re-granting here.
    // What stays direct: the top-level operator reads (next/phase/snapshot/
    // statusline/actions/run — owned by `work`, not the planner's foreign
    // namespace) and the sanctioned `prx tools git|bd|wt` write-policy wrappers.
    ...actorRuleset("plan", {
      role: "reader",
      denyWrite: false,
      extraAllow: [
        "TodoWrite",
        "Bash(prx next:*)",
        "Bash(prx phase:*)",
        "Bash(prx snapshot:*)",
        "Bash(prx statusline:*)",
        "Bash(prx actions:*)",
        "Bash(prx run profile:*)",
        "Bash(prx tools git:*)",
        "Bash(prx tools bd:*)",
        "Bash(prx tools wt:*)",
      ],
    }),
    allowedActors: ["git", "gh", "wt", "beads", "prx", "llm_agent"],
    disallowedActors: ["gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.plan],
  },
  // GH-1004: closes the GH-998 verb-surface epic by collapsing the intake
  // allowlist onto `prx intake <verb>` only. Raw `gh:*` / `bd:*` / `git:*`
  // are denied at the flag layer (see `buildOpsIntakeClaudeRuntimeProfile`),
  // matching the GH-1147 plan-profile precedent so accidental raw-tool use
  // fails as a permission denial rather than silently working.
  intake: {
    name: "intake",
    binding: "mainx",
    banner:
      "prx intake agent — search → file-or-merge → mirror → comment. No code edits, no execution.",
    // GH-1530: registry-derived. The own `prx intake:*` namespace glob is the
    // entire operator surface (sub-verb discovery via `prx intake --help`);
    // base reads + shared raw-CLI deny do the rest.
    ...actorRuleset("intake", { role: "reader" }),
    allowedActors: ["gh", "beads", "prx"],
    disallowedActors: ["git", "wt", "gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.intake],
  },
  triage: {
    name: "triage",
    binding: "mainx",
    banner:
      "prx triage agent — promote intake → beads, label sync, classifier. No execution.",
    // GH-1530: registry-derived. The own `prx triage:*` namespace glob covers
    // classify/apply (and any new triage verb). Triage does not pass
    // --allowedTools today, so the toolset is documentary (it surfaces in the
    // prompt's "Allowed tools" line).
    //
    // GH-1530 PR-6 (target-authoritative ocap flip): the cross-namespace
    // `prx intake search` read migrates to `prx triage dispatch --actor=intake
    // -- search` (own `Bash(prx triage:*)` glob covers the dispatch verb; intake
    // admits triage as a caller). The `prx tools labels sync` wrapper stays
    // direct, and the raw `bd`/`gh issue` writes the triage operator runs stay
    // — they survive the shared raw-CLI deny documentarily via most-specific-
    // match, and are not `prx <actor>` namespaces the lint governs.
    ...actorRuleset("triage", {
      role: "reader",
      extraAllow: [
        "Bash(prx tools labels sync:*)",
        "Bash(bd create:*)",
        "Bash(bd update:*)",
        "Bash(bd dep:*)",
        "Bash(gh issue comment:*)",
        "Bash(gh issue edit:*)",
      ],
    }),
    allowedActors: ["gh", "beads", "prx"],
    disallowedActors: ["git", "wt", "gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.triage],
  },
  // GH-1172/GH-1238: implement profile — actor-namespace executor toolset
  // for `prx implement`. Collapsed in GH-1238 from the GH-1172 sprawl
  // (40+ entries spanning prx model/scout/next/phase/...) toward the
  // executor's own namespace plus the consumed-slot read/close surface.
  // Discovery is pushed to the system prompt ("`prx implement --help`")
  // rather than encoded as a long allowlist. Destructive ops stay blocked
  // at the flag layer even when the operator ratchets looser inside claude.
  implement: {
    name: "implement",
    binding: "work-unit",
    banner:
      "prx implement agent — executor profile with Edit/Write enabled. Stay scoped to the saved plan slot; route writes through `prx tools git/bd/wt` wrappers; do not widen scope. Read your plan with `prx implement dispatch --actor=plan -- show <id>` (returns a CAS handle to dereference). When the work is ready to ship, stage it with `prx implement dispatch --actor=submit -- stage <id>` and exit to `prx submit agent` for the push/PR/merge cycle — do not open PRs from here. Exit and re-enter via `prx plan session` to return to read-only planning.",
    // GH-1530: registry-derived via `actorRuleset("implement", { role:
    // "executor", … })`. The executor base toolset (Edit/Write/Task*/bun) +
    // the own `prx implement:*` namespace glob come from the helper.
    //
    // GH-1530 PR-6 (target-authoritative ocap flip): the cross-namespace verbs
    // the executor used to run directly — doctor/publisher diagnostics, the
    // submit producer (body-template/postmerge/stage), and the consumed-slot
    // plan reads (show/load/close) — now go through `prx implement dispatch
    // --actor=<target> -- <verb>` (own `Bash(prx implement:*)` glob covers the
    // dispatch verb; doctor/publisher/submit/plan each admit `implement`). Only
    // the `prx tools git|bd|wt` write-policy wrappers stay direct.
    //
    // ai-home-emsht (st3a3): the executor stages + hands off and NEVER opens a
    // PR — `submit stage` (read-only producer, now dispatched) is the sanctioned
    // ship-out, `submit publish` stays operator-only. ai-home-d39ug / GH-1899:
    // raw `git`/`gh` are fully blocked by SHARED_DENY (the `prx tools git`
    // wrapper survives — the matcher keys on the `prx` head).
    ...actorRuleset("implement", {
      role: "executor",
      extraAllow: [
        // Policy-enforcing wrapped CLIs for code/branch/worktree writes.
        "Bash(prx tools git:*)",
        "Bash(prx tools bd:*)",
        "Bash(prx tools wt:*)",
      ],
      extraDeny: [
        // Specific destructive flags — subsumed by the shared `git`/`gh`/`rm`
        // blankets but kept legible as documented defense-in-depth.
        "Bash(git push --force:*)",
        "Bash(git push --force-with-lease:*)",
        "Bash(git reset --hard:*)",
        "Bash(rm -rf:*)",
        "Bash(rm -fr:*)",
        // GH-1238: merge belongs to author/quality verbs, not the executor.
        "Bash(gh pr merge:*)",
        // GH-1238: routing through prx keeps beads writes auditable.
        "Bash(bd create:*)",
        "Bash(bd close:*)",
      ],
    }),
    allowedActors: ["git", "gh", "wt", "beads", "prx", "llm_agent"],
    disallowedActors: ["gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.implement],
    // GH-2418: flip the OCAP gate on for the executor profile. An implement
    // dispatch to its allowed targets must now present a typed inputArtifact
    // matching the target contract (scout → `query`, plan → `uow`); a bare
    // `prx implement dispatch --actor=scout -- ...` is denied (capability_denied)
    // until `--input-artifact-type=query` is supplied. Confined to this profile.
    typedDispatchRejection: true,
  },
  // GH-1740: submit profile — pre-merge `Closes #N` staging + post-merge
  // body sweep.
  // GH-1900: flipped to work-unit binding. The session prepares a
  // CAS-backed submit artifact for the bound unit and hands off to
  // `prx submit publish --from-cas <ref>`. No branch/edit, no intake filing;
  // publish itself is not in the session allowlist (operator-invoked).
  submit: {
    name: "submit",
    binding: "work-unit",
    banner:
      "prx submit agent — work-unit submit operator: prep CAS artifact and hand off to `prx submit publish --from-cas <ref>`. No branch/edit, no intake filing.",
    // GH-1530: registry-derived. `omitOwnNamespace: true` — submit must NOT
    // broaden to `Bash(prx submit:*)`, because that would re-admit `prx submit
    // publish` (operator-only; denied below). Instead the verb-specific own
    // grants (body-template/postmerge/stage) ride `extraAllow`.
    //
    // GH-1530 PR-6 (target-authoritative ocap flip): the cross-namespace plan
    // reads migrate to `prx submit dispatch --actor=plan -- show|load`. Because
    // the own-namespace glob is omitted, the dispatch verb is granted
    // explicitly as `Bash(prx submit dispatch:*)` (head is the owner `submit`,
    // so the no-foreign-namespace lint passes; it does not match `submit
    // publish`, which stays denied below). plan admits `submit` as a caller.
    ...actorRuleset("submit", {
      role: "reader",
      omitOwnNamespace: true,
      extraAllow: [
        "Bash(prx submit body-template:*)",
        "Bash(prx submit postmerge:*)",
        // GH-2262: artifact staging path — the producer verb resolves git state
        // into `<UoW>:submit@<slot>` in the submit CAS (reads only; it never
        // pushes). Publish itself stays out of the allowlist; the operator (or
        // next-step automation) runs `prx submit publish --from-cas <ref>`.
        "Bash(prx submit stage:*)",
        // Own-namespace dispatch verb (omitOwnNamespace drops the broad glob).
        "Bash(prx submit dispatch:*)",
      ],
      extraDeny: [
        // GH-1900: publish must not be reachable from inside the session — it
        // runs after exit using the CAS ref the session produced.
        "Bash(prx submit publish:*)",
      ],
    }),
    allowedActors: ["gh", "beads", "prx"],
    disallowedActors: ["git", "wt", "gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.submit],
  },
  // GH-1206 + ai-home-2ow2v: author profile — work-unit-bound PR-body
  // authoring surface between `implement` and `prune`. Reads source + diff +
  // saved plan; ALL PR writes go through the forge actor via dispatch (no raw
  // gh). No Edit/Write on source; no `git push`. Runbook in
  // docs/prx/author-runbook.md.
  author: {
    name: "author",
    binding: "work-unit",
    banner:
      "prx author agent — PR author profile: read source + diff + saved plan; write the PR via the forge — `prx author dispatch --actor=publisher -- pr open|comment|edit` and `--actor=publisher -- ready|draft` — and read review threads via `--actor=repo -- pr-comments` (each returns a CAS handle to dereference). No raw gh, no code edits, no push. See docs/prx/author-runbook.md for the CLAUDE.md PR Standards run-sheet.",
    // GH-1530: registry-derived own `prx author:*` glob + reader base.
    //
    // ai-home-2ow2v (author own-namespace lockdown): the author session runs
    // ONLY its own namespace + reader built-ins. The raw `gh pr {create,edit,
    // ready,view,comment}` working set is removed — PR *writes* go through the
    // forge actor (`prx author dispatch --actor=publisher -- pr open|comment|
    // edit`, `--actor=publisher -- ready|draft`) and PR *reads* through
    // `--actor=repo -- pr-comments` (publisher + repo each admit `author`).
    //
    // git is a SURFACE, not an ambient grant: `prx tools git` is intentionally
    // NOT granted here — an actor must not get git just because its work touches
    // git. Diff/log reads for body composition go through dispatch (scout for
    // repo inventory; `prx author body-template` renders the structured body)
    // and the in-session Read/Grep/Glob. Surface-level ocap gating of
    // git/bd/filesystem across all profiles is the effect-model follow-up.
    ...actorRuleset("author", {
      role: "reader",
      extraAllow: [
        "TodoWrite",
      ],
    }),
    allowedActors: ["prx"],
    disallowedActors: ["git", "gh", "wt", "beads", "gmail", "gcal"],
    allowedDispatchTargets: [...defaultDispatchCapabilities.author],
  },
  // GH-2394: scratch profile — an ad-hoc, work-unit-UNBOUND Claude session that
  // is *safe by default*. A raw `claude` opens with ambient authority (every
  // tool live, all claude.ai account connectors mounted, no OS sandbox);
  // `prx scratch` inverts that default and ships three layers, all on:
  //   1. permission flag-layer — `--permission-mode plan` + the strict
  //      `--allowedTools` below + the explicit `disallowedTools` denies;
  //   2. MCP lockdown — `--strict-mcp-config` + an inline empty MCP map AND
  //      `ENABLE_CLAUDEAI_MCP_SERVERS=false` (the only switch that kills the
  //      claude.ai connectors — `--strict-mcp-config` does NOT);
  //   3. Claude Code's built-in sandbox via `--settings` (seatbelt-backed on
  //      macOS): FS jailed to cwd + $TMPDIR, network allowlist,
  //      `allowUnsandboxedCommands:false`.
  // `prx scratch --unsafe` is the single escape hatch back to ambient
  // authority. See docs/prx/scratch-runbook.md.
  scratch: {
    name: "scratch",
    binding: "mainx",
    banner:
      "prx scratch — least-privilege, work-unit-UNBOUND Claude session (safe by default). Read/Grep/Glob + `prx:*` only; Edit/Write and raw git/gh/bd are denied at the flag layer; claude.ai connectors (Notion/Google/computer-use) are killed via ENABLE_CLAUDEAI_MCP_SERVERS=false; the macOS sandbox jails writes to the cwd + $TMPDIR and the network to a minimal allowlist. `prx scratch --unsafe` is the single escape hatch back to ambient authority (connectors on, sandbox off). See docs/prx/scratch-runbook.md.",
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(prx:*)",
    ],
    // Explicit legibility denies layered on the strict allowlist (mirrors the
    // plan/author deny shape): anything not on `allowedTools` is already denied,
    // but naming the high-blast-radius tools keeps the safe-by-default intent
    // legible in `--dry-run --format json` and in the prompt's deny line.
    disallowedTools: [
      "Edit",
      "Write",
      "Bash(gh:*)",
      "Bash(bd:*)",
      "Bash(git:*)",
      "Bash(rm:*)",
      "WebFetch",
      "Agent",
    ],
    allowedActors: ["prx", "llm_agent"],
    // The claude.ai connector actors are explicitly denied (killed by the
    // ENABLE_CLAUDEAI_MCP_SERVERS=false env in the builder).
    disallowedActors: ["git", "gh", "wt", "beads", "gmail", "gcal", "notion_mcp"],
    // Ad-hoc sessions never fan out to other actors.
    allowedDispatchTargets: [],
  },
};

export function getSessionProfile(name: SessionProfileName): SessionProfileConfig {
  return SESSION_PROFILES[name];
}

/**
 * GH-1828: tags how a profile is dispatched at the executor. `"subprocess"`
 * (the default) keeps the legacy `localRuntimeExecutor` spawn shape — the only
 * shape interactive callers ever take. `"sdk"` routes through the Anthropic
 * Agent SDK service (`src/claude/agent_service.ts`), which requires the
 * profile to carry an `sdkSpec` describing the prompt / model / tool-allowlist
 * payload. Per docs/spikes/GH-1827-actor-session-modes.md §3.2 the SDK path
 * is non-interactive-only.
 */
export type RuntimeAgentRuntime = "sdk" | "subprocess";

/**
 * Headless-first axis (docs/spikes/headless-first-profiles.md). `"headless"`
 * runs the agent non-interactively (claude → Agent SDK; other agents → their
 * `--print` mode); `"interactive"` runs the CLI in a tmux pane. This is the
 * primary dispatch axis; the SDK-vs-subprocess backend is *derived* from
 * `(interaction, command)` rather than chosen directly. The intended default
 * as profiles migrate is `"headless"`.
 */
export type RuntimeInteraction = "headless" | "interactive";

/** Derived execution backend for a profile (see `resolveAgentBackend`). */
export type RuntimeAgentBackend = "sdk" | "subprocess";

/**
 * GH-1828: SDK-call payload carried by `RuntimeProfileProjection` when
 * `agentRuntime === "sdk"`. The legacy `command`/`args` fields stay populated
 * for dry-run printing and operator observability; the SDK runtime reads its
 * call shape from `sdkSpec` instead of re-parsing argv.
 */
export type RuntimeAgentSdkSpec = {
  prompt: string;
  /**
   * GH-1407 — cache-stable prefix of the SDK `systemPrompt` array. The SDK
   * service joins these entries verbatim, inserts the SDK-exported
   * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker, and appends
   * `systemPromptDynamic`. Content here must be byte-identical across calls
   * so the Anthropic prompt cache hits — keep workUnitId / plan-path /
   * per-batch values out and put them in `systemPromptDynamic`.
   */
  systemPromptStable?: string[];
  /**
   * GH-1407 — dynamic suffix appended after the cache boundary marker. Use
   * for workUnitId anchors, plan-path injections, and per-batch user data
   * that legitimately differs between invocations.
   */
  systemPromptDynamic?: string[];
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Mirrors `--tools` — restricts the built-in tool set. */
  tools?: string[];
  /**
   * MCP server map (mirrors `--mcp-config` content). Builders typically leave
   * this unset for the project-scoped MCP file path — the SDK loader reads
   * `settingSources` and the runtime mcp.json automatically. Tests inject `{}`.
   */
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  settingSources?: Array<"user" | "project" | "local">;
  includePartialMessages?: boolean;
  maxTurns?: number;
  /**
   * GH-2337 — opt into the in-process `submit_plan` capture seam. When true,
   * agent_service injects a `prx-plan` SDK MCP server whose `submit_plan` tool's
   * input schema is PlanArtifactShape; the validated artifact (rendered) becomes
   * the success body instead of free-text stdout. A successful run that never
   * calls submit_plan returns a typed `failed` result. Pure projection only
   * declares the capability — the live server is built at the IO boundary.
   */
  capturePlanArtifact?: boolean;
};

export type RuntimeProfileProjection = {
  profile: RuntimeProfileName;
  mode: RuntimeMode;
  command: "claude" | "codex" | "gh" | "gemini" | "cursor-agent";
  args: string[];
  fallbackArgs?: string[] | undefined;
  env?: Record<string, string>;
  /**
   * GH-1828: how the profile is dispatched. Defaults to `"subprocess"` when
   * absent (preserves all pre-1828 behavior). Profiles that set `"sdk"` MUST
   * also set `sdkSpec`; the executor refuses the route otherwise.
   */
  agentRuntime?: RuntimeAgentRuntime;
  /**
   * Headless-first axis. When absent, the executor derives it from
   * `agentRuntime` for back-compat (`"sdk"` → `"headless"`, else
   * `"interactive"`). See `resolveInteraction` / `resolveAgentBackend` and
   * docs/spikes/headless-first-profiles.md.
   */
  interaction?: RuntimeInteraction;
  sdkSpec?: RuntimeAgentSdkSpec | undefined;
  trustTiers: {
    tierA_controlled: string[];
    tierB_partial: string[];
    tierC_ambient: string[];
  };
  sourcesOfTruth: {
    agents: "generated" | "inline_prompt";
    mcp: "project-only" | "codex-config";
    plugins: string[];
    connectors: string[];
  };
  allowedActors: string[];
  disallowedActors: string[];
  notes: string[];
  /**
   * GH-2014: how the caller wants the tmux session to be presented after
   * boot. `"foreground"` (default) attaches the operator into the live mux
   * session; `"background"` skips the attach and prints a re-entry hint
   * instead, returning control to the caller's shell.
   *
   * Carried on the projection so the value flows through the session-entry
   * machine into the CLI handler that owns the actual `attachMuxSession`
   * call. Only `OPEN_PLAN_SESSION` and `OPEN_IMPLEMENT_SESSION` consult
   * this today; absence means `"foreground"`.
   */
  attachMode?: "foreground" | "background" | undefined;
};

/**
 * Headless-first axis resolution. Explicit `profile.interaction` wins; when
 * absent the value is derived from `agentRuntime` for back-compat (`"sdk"` →
 * `"headless"`, else `"interactive"`). As profiles migrate (step 2+ of the
 * headless-first ADR) they set `interaction` explicitly and the default
 * shifts to `"headless"`.
 */
export function resolveInteraction(profile: RuntimeProfileProjection): RuntimeInteraction {
  return profile.interaction ?? (profile.agentRuntime === "sdk" ? "headless" : "interactive");
}

/**
 * Execution backend derived from `(interaction, command)`. The Agent SDK is
 * claude's headless implementation; every other combination is a subprocess
 * (headless `--print` one-shots and interactive tmux sessions alike). Backend
 * is derived, never chosen — callers set `interaction`, not the backend.
 */
export function resolveAgentBackend(profile: RuntimeProfileProjection): RuntimeAgentBackend {
  return resolveInteraction(profile) === "headless" && profile.command === "claude"
    ? "sdk"
    : "subprocess";
}

const workUnitAllowedActors = ["git", "gh", "wt", "beads", "prx", "llm_agent"] as const;
const workUnitDisallowedActors = ["gmail", "gcal"] as const;
const gitSafePath = fileURLToPath(new URL("../../scripts/git-safe", import.meta.url));
const ghSafePath = fileURLToPath(new URL("../../scripts/gh-safe", import.meta.url));
const wtSafePath = fileURLToPath(new URL("../../scripts/wt-safe", import.meta.url));
const bdSafePath = fileURLToPath(new URL("../../scripts/bd-safe", import.meta.url));
const prxSafePath = fileURLToPath(new URL("../../scripts/prx-safe", import.meta.url));
const runtimeAgentsPath = ".pr/local/runtime/agents.json";
const runtimeMcpPath = ".pr/local/runtime/mcp.json";
const runtimeSchemaPath = ".pr/local/runtime/output.schema.json";
const runtimeBootstrapPath = ".pr/local/runtime/bootstrap.sh";

export function buildTaskRoleAgentId(workUnitId: string, role: TaskAgentRole): string {
  return `${workUnitId}-${role}`;
}

// GH-1407 — the work-unit machine-first prompt is split so the part that is
// invariant across calls (role posture, machine-first guidance) lives in a
// cache-eligible prefix and the per-call workUnitId / plan-path injection
// lives in a dynamic suffix. The SDK service slots a
// `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between them so the Anthropic prompt
// cache can match the prefix across UoWs that share a role.
function buildRoleStableSystemPrompt(role: TaskAgentRole = "executor"): string {
  const roleSpecific = role === "planner"
    ? "You are the planner: read-only, machine-first, and responsible for scope, constraints, and success criteria. Do not edit code."
    : role === "executor"
      ? "You are the executor: summarize the relevant model boundary, produce a short implementation plan, then implement only the already-confirmed scope. Do not widen scope."
      : role === "tester"
        ? "You are the tester: validate with tests and diagnostics first. Prefer evidence over edits."
        : "You are the reviewer: read-only, validate diffs and evidence, and reject unclear or unsafe work.";

  return [
    `You are the ${role} agent.`,
    "Stay strictly scoped to your work unit, its current directory, and the configured tool boundaries.",
    "Do not invent or switch identities.",
    "Start from the state machine first: inspect prx graph --format xstate-system-ts, prx model --scope workflow, and prx actors --scope workflow before changing implementation details.",
    "Before making code changes, summarize the relevant workflow states, actor ownership, events, and schema boundaries for this task, then produce a short implementation plan tied to that model.",
    "Prefer the parity chain as the source of truth for branch, worktree, and PR alignment; leave room to extend it beyond the current repair flow.",
    "Prefer XState states/events, actor ownership, Zod schemas, and JSON schema boundaries as the source of truth before UI or workflow code.",
    "Implement actors, events, and projections after the model is clear; do not jump straight to ad hoc code edits.",
    roleSpecific,
  ].join(" ");
}

/**
 * prx-pe1 (slice 2): the system prompt for the HEADLESS executor, derived for
 * its actual posture instead of the shared interactive mandate.
 *
 * The shared `buildRoleStableSystemPrompt("executor")` tells the agent to "start
 * from the state machine" by running `prx graph` / `prx model` / `prx actors` —
 * fine for an interactive executor (TTY approval, dispatch reads), but those
 * CLIs are DENIED in the headless allowlist, so a headless run that obeyed the
 * mandate dead-ended ("every executable I need is blocked"). The model-first
 * analysis those commands would produce is already in the embedded plan, so the
 * headless executor works FROM the artifact and reads the codebase directly
 * (Read/Grep/Glob) rather than re-deriving scope through denied tools. This is
 * the "prompt = projection(input artifact, actor)" rule: the actor's real
 * toolset shapes what it is told to do.
 */
function buildHeadlessExecutorStableSystemPrompt(): string {
  return [
    "You are the executor agent, running headlessly — there is no interactive approval, so any tool outside your granted allowlist simply cannot run.",
    "Stay strictly scoped to your work unit, its current directory, and the configured tool boundaries. Do not invent or switch identities.",
    "Your confirmed scope is the approved plan embedded in the task prompt; it already carries the model-first analysis (workflow states, actor ownership, event/schema boundaries). Implement exactly that scope and do not widen it.",
    "Do NOT run `prx`, `bd`, `gh`, or raw `git` to re-derive scope or inspect the model — they are intentionally outside your headless toolset. Read the codebase directly with Read/Grep/Glob instead.",
    "Use only your granted tools: edit and write files directly, run the project checks, and route git / beads / worktree writes through the `prx tools git|bd|wt` wrappers.",
    "If the embedded plan is insufficient to proceed safely, stop and report precisely what is missing — do not guess or fabricate work.",
  ].join(" ");
}

function buildWorkUnitDynamicSystemSegment(
  workUnitId: string,
  planPath?: string,
): string {
  const segments = [`Work unit: ${workUnitId}.`];
  if (planPath) segments.push(`Execute the plan at ${planPath}.`);
  return segments.join(" ");
}

function buildWorkUnitMachineFirstPrompt(workUnitId: string, role: TaskAgentRole = "executor"): string {
  // Legacy single-string surface kept for subprocess callers (--append-system-prompt
  // in argv shapes). SDK callers should reach for the split helpers above
  // and feed `sdkSpec.systemPromptStable` / `sdkSpec.systemPromptDynamic`.
  return `${buildRoleStableSystemPrompt(role)} ${buildWorkUnitDynamicSystemSegment(workUnitId)}`;
}

export function buildWorkUnitClaudeRuntimeProfile(input: {
  agentId: string;
  workUnitId: string;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const baseArgs = ["--agent", input.agentId];
  const fullArgs = [
    "--agents",
    runtimeAgentsPath,
    ...baseArgs,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--mcp-config",
    runtimeMcpPath,
    "--tools",
    "Read,Edit,Bash",
    "--allowedTools",
    `Read,Edit,Bash(${gitSafePath}:*),Bash(${ghSafePath}:*),Bash(${wtSafePath}:*),Bash(${bdSafePath}:*),Bash(${prxSafePath}:*)`,
    "--permission-mode",
    "plan",
    "--json-schema",
    runtimeSchemaPath,
    "--no-session-persistence",
    "--output-format",
    input.ioFormat,
  ];
  const devArgs = [
    ...baseArgs,
    "--allowedTools",
    `Read,Edit,Bash(${gitSafePath}:*),Bash(${ghSafePath}:*),Bash(${wtSafePath}:*),Bash(${prxSafePath}:*)`,
    "--permission-mode",
    "plan",
    "--output-format",
    input.ioFormat,
  ];
  const args = input.mode === "full" ? fullArgs : devArgs;
  if (input.ioFormat === "stream-json") {
    args.push("--input-format", "stream-json");
  }

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "claude",
    args,
    trustTiers: {
      tierA_controlled: ["generated agents", "project/local settings", "project MCP config", "explicit plugins"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "generated",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      "Machine is source of truth; Claude is a stateless executor.",
      "Identity is bound: agentId == workUnitId.",
      "Interactive runs rely on cwd as the worktree boundary; --worktree is omitted because it stalls Claude Code in practice.",
      "MCP visibility is locked to generated config.",
      "Ambient connectors and built-ins are outside work-unit authority.",
      ...(input.mode === "dev"
        ? ["Dev mode: simplified interactive profile with reduced hardening."]
        : []),
    ],
  };
}

export function buildWorkUnitClaudeInteractiveRuntimeProfile(input: {
  workUnitId: string;
  role: TaskAgentRole;
  hasPriorSession: boolean;
  planPath?: string | undefined;
}): RuntimeProfileProjection {
  const basePrompt = buildWorkUnitMachineFirstPrompt(input.workUnitId, input.role);
  const prompt = input.planPath
    ? `${basePrompt} Execute the plan at ${input.planPath}.`
    : basePrompt;
  const args = [
    "--name",
    input.workUnitId,
    "--mcp-config",
    runtimeMcpPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "plan",
    "--append-system-prompt",
    prompt,
  ];
  if (input.hasPriorSession) {
    args.push("--continue");
  }

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["project cwd", `${input.role} system prompt`, "project MCP config"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Interactive ${input.role} surface: claude 2.1.x blocks edits in --permission-mode plan; operator can ratchet looser from inside claude.`,
      `${input.role} prompt is injected via --append-system-prompt; --agent/--tools are omitted because they coerce --print mode.`,
      `Display name is pinned to ${input.workUnitId} via --name so the prompt-box badge, /resume picker, and terminal title match the canonical work-unit id.`,
      input.hasPriorSession
        ? "Resumes the most recent claude conversation for this cwd via --continue."
        : "First-entry launch (no prior claude session saved for this cwd).",
      ...(input.planPath
        ? [`Plan injection: appended 'Execute the plan at ${input.planPath}.' to system prompt.`]
        : []),
    ],
  };
}

export function buildWorkUnitClaudePlanPrintRuntimeProfile(input: {
  workUnitId: string;
  // GH-1825 — when set, the planner receives the partial-draft content from
  // the prior cancelled run and continues from there instead of starting
  // fresh. Modifies the user prompt only; the cache-stable system prefix
  // stays byte-identical (GH-1407 cache hits keep working across resume).
  resumePartialPlan?: string;
  // prx-pl2: the unit's source authority (the bead/issue body, `<unit>:source@pinned`).
  // Embedded so the planner plans the ACTUAL task — it cannot reach for `bd`/`prx`
  // to hydrate the body (gated in its sandbox), and without this it fabricates
  // scope from the codebase. Same fix as implement embedding the plan (prx-pe1).
  sourceBody?: string;
}): RuntimeProfileProjection {
  const role: TaskAgentRole = "planner";
  // GH-1407 — split the system prompt so the role-level posture is
  // cache-stable and only the workUnitId anchor varies per call. Subprocess
  // dry-run argv keeps the joined string for operator readability.
  const systemPromptStable = buildRoleStableSystemPrompt(role);
  const systemPromptDynamic = buildWorkUnitDynamicSystemSegment(input.workUnitId);
  const systemPrompt = `${systemPromptStable} ${systemPromptDynamic}`;
  // prx-ei6: `capturePlanArtifact` injects the `submit_plan` tool, so the
  // planner MUST submit through it — not emit prose. The prompt names the tool
  // and its fields and bans free-text; a run that ends without calling
  // submit_plan is a contract violation (agent_service → "planner did not call
  // submit_plan"). The previous "Output plain markdown" instruction directly
  // contradicted the capture contract, so the model always emitted prose.
  // prx-pl2: when the source body is available, embed it so the planner plans
  // the ACTUAL unit (it can't hydrate via gated bd/prx) and tell it NOT to
  // re-fetch. Falls back to the old fetch-it-yourself line when absent.
  const sourceSegment = input.sourceBody !== undefined
    ? [
        "The work unit's source authority (issue/bead) is reproduced below — this is the task.",
        "",
        "----- BEGIN WORK UNIT SOURCE -----",
        input.sourceBody,
        "----- END WORK UNIT SOURCE -----",
        "",
        "Read the codebase directly (Read/Grep/Glob) to ground the plan; do NOT run `prx`/`bd` to re-fetch the source — it is above.",
      ].join("\n")
    : "Hydrate workflow context (issue body, beads rows, parity chain) before proposing scope.";
  const submitLine =
    "Submit the plan by calling the `submit_plan` tool with these fields: problem, scope, approach, changes (a file-level list), risks, and acceptance criteria. The `submit_plan` call is the deliverable — do not reply with prose or markdown, and do not ask clarifying questions.";
  const userPrompt = input.resumePartialPlan !== undefined
    ? [
        `Continue drafting the implementation plan for ${input.workUnitId} from this partial draft:`,
        "",
        input.resumePartialPlan,
        "",
        submitLine,
      ].join("\n")
    : [
        `Draft the implementation plan for ${input.workUnitId}.`,
        sourceSegment,
        submitLine,
      ].join("\n");
  const args = [
    "--print",
    "--output-format",
    "text",
    "--mcp-config",
    runtimeMcpPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "plan",
    "--append-system-prompt",
    systemPrompt,
    userPrompt,
  ];

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: role,
      ...agentOtelEnv(role),
    },
    // GH-1828: non-interactive callers route through the Agent SDK service.
    // The legacy `command`/`args` shape stays populated for dry-run printing
    // and operator observability; `executeAgentProfile` reads `sdkSpec`.
    agentRuntime: "sdk",
    sdkSpec: {
      prompt: userPrompt,
      systemPromptStable: [systemPromptStable],
      systemPromptDynamic: [systemPromptDynamic],
      permissionMode: "plan",
      strictMcpConfig: true,
      settingSources: ["project", "local"],
      // prx-pln: enforce the structured plan artifact. With this set,
      // executeAgentProfile injects the `prx-plan` MCP `submit_plan` tool (input
      // schema = PlanArtifactShape), so the planner MUST submit a schema-valid
      // PlanArtifact (non-empty `scope` …) rather than free prose — the rendered
      // artifact (with `## Scope`) becomes the saved body and passes the shape
      // gate, so `prx implement agent` accepts it. (Was declared but never set,
      // so the planner ran unconstrained and emitted prose that failed the gate.)
      capturePlanArtifact: true,
    },
    trustTiers: {
      tierA_controlled: ["project cwd", `${role} system prompt`, "project MCP config"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Non-interactive ${role} surface: --print emits the plan as a one-shot artifact (handoff to Ultraplan).`,
      "--permission-mode plan keeps the run read-only; --print has no TTY for edit prompts so edits cannot be approved.",
      "No --continue: print mode is one-shot per invocation; prior session state is not resumed.",
      "GH-1828: routes through the Anthropic Agent SDK (claude_sdk implementation); typed cancellation, partial capture, usage telemetry. Legacy argv preserved for dry-run.",
    ],
  };
}

/**
 * Headless implement profile (headless-first ADR, step 2). The SDK counterpart
 * to `buildOpsImplementClaudeRuntimeProfile` (interactive/tmux): an autonomous
 * executor run via the Agent SDK, selected when `prx implement` is NOT given
 * `--interactive`. Mirrors the plan-print builder's cache-stable system-prompt
 * split, but with an edit-capable posture.
 *
 * Authority posture (the reviewable security knob): `permissionMode:
 * "acceptEdits"` auto-accepts file edits; `allowedTools` is the
 * `SESSION_PROFILES.implement` allowlist, which pre-authorizes those tools so
 * they run without a prompt. Anything outside the allowlist would need an
 * approval that a headless run has no TTY to give, so it is bounded by
 * construction — and the underlying capability calls remain `@bounded-systems/policy`-gated
 * regardless. Real authority lives in the wrappers, not the SDK prompt gate.
 */
export function buildWorkUnitClaudeImplementSdkRuntimeProfile(input: {
  workUnitId: string;
  planPath?: string | undefined;
  // prx-pe1: the validated plan artifact body (the consumed `<unit>:plan@*`
  // slot). When present it is embedded in the prompt so the executor has its
  // confirmed scope FROM THE ARTIFACT — it never has to reach for `prx`/`bd` to
  // read scope (those are denied in the headless allowlist, which is why a
  // scope-blind executor refused). This is the plan→implement edge consumed:
  // the prompt is derived from the input artifact, not hardcoded.
  planBody?: string | undefined;
}): RuntimeProfileProjection {
  const role: TaskAgentRole = "executor";
  // prx-pe1 (slice 2): headless-posture system prompt — derived for the
  // executor's real (restricted) toolset, not the shared interactive mandate
  // that orders denied `prx graph/model/actors` reads.
  const systemPromptStable = buildHeadlessExecutorStableSystemPrompt();
  const dynamicSegments = [buildWorkUnitDynamicSystemSegment(input.workUnitId)];
  if (input.planPath) {
    dynamicSegments.push(`Execute the plan at ${input.planPath}.`);
  }
  const systemPromptDynamic = dynamicSegments.join(" ");
  const systemPrompt = `${systemPromptStable} ${systemPromptDynamic}`;
  const userPrompt = input.planBody
    ? [
        `Execute the approved implementation plan for ${input.workUnitId}, reproduced in full below.`,
        "It is your confirmed scope — implement exactly this, do not widen it, and do not ask clarifying questions.",
        "",
        "----- BEGIN APPROVED PLAN -----",
        input.planBody,
        "----- END APPROVED PLAN -----",
        "",
        // prx-who: do NOT tell the executor to run the checks — the toolchain
        // (bun) is outside its exec sandbox, so it can't, and a real run wasted
        // its budget trying. prx re-runs + signs the checks (checks/v1) itself
        // after the commit. The executor's job is the edit + the commit.
        "Make the file changes and commit the work. Do NOT run the project checks (`bun test` / typecheck) yourself — the toolchain is outside your sandbox; prx runs and signs them after you commit. Commit even if you cannot run them.",
      ].join("\n")
    : [
        `Execute the implementation plan for ${input.workUnitId}.`,
        "Make the file changes and commit the work; do not ask clarifying questions. Do NOT run the project checks yourself — prx runs and signs them after you commit.",
      ].join(" ");
  const allowedTools = [...SESSION_PROFILES.implement.allowedTools];
  const args = [
    "--print",
    "--output-format",
    "json",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    systemPrompt,
    userPrompt,
  ];

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: role,
      ...agentOtelEnv(role),
    },
    agentRuntime: "sdk",
    interaction: "headless",
    sdkSpec: {
      prompt: userPrompt,
      systemPromptStable: [systemPromptStable],
      systemPromptDynamic: [systemPromptDynamic],
      permissionMode: "acceptEdits",
      allowedTools,
      strictMcpConfig: true,
      settingSources: ["project", "local"],
    },
    trustTiers: {
      tierA_controlled: ["project cwd", `${role} system prompt`, "implement allowlist", "project MCP config"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Headless ${role} surface: autonomous SDK run (headless-first step 2). Selected when \`prx implement\` is not given --interactive.`,
      "permissionMode=acceptEdits + the implement allowlist is the authority posture; non-allowlisted tools have no headless approval path and underlying capability calls stay @bounded-systems/policy-gated.",
      "GH-1828: routes through the Anthropic Agent SDK; typed cancellation, partial capture, usage telemetry. Legacy argv preserved for dry-run.",
    ],
  };
}

export function buildWorkUnitCodexRuntimeProfile(input: {
  workUnitId: string;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId);
  const interactiveArgs = ["resume", "-s", "workspace-write", "-a", "on-request", input.workUnitId, prompt];
  const freshArgs = ["-s", "workspace-write", "-a", "on-request", prompt];

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "codex",
    args: interactiveArgs,
    fallbackArgs: freshArgs,
    trustTiers: {
      tierA_controlled: ["project cwd", "inline work-unit prompt", "explicit Codex sandbox/approval flags"],
      tierB_partial: ["user-scoped Codex config"],
      tierC_ambient: ["ambient Codex MCP servers", "global Codex defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "codex-config",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      "Machine is source of truth; Codex is a stateless executor.",
      "Identity is bound to the current workUnitId via the inline work-unit prompt.",
      "Interactive runs target the work-unit id as the preferred Codex thread/session key, then fall back to a fresh interactive session.",
      "Codex MCP and tool surfaces are controlled through Codex config rather than Claude project MCP files.",
      ...(input.mode === "dev"
        ? ["Dev mode currently uses the same Codex runner shape as full mode."]
        : []),
    ],
  };
}

export function buildWorkUnitCopilotRuntimeProfile(input: {
  workUnitId: string;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId);

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "gh",
    args: ["copilot", "--", "-i", prompt],
    trustTiers: {
      tierA_controlled: ["project cwd", "inline work-unit prompt", "explicit gh copilot launch path"],
      tierB_partial: ["user-scoped Copilot config"],
      tierC_ambient: ["ambient Copilot MCP servers", "global Copilot defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      "Machine is source of truth; GitHub Copilot is a stateless executor.",
      "Identity is bound to the current workUnitId via the inline work-unit prompt.",
      "Interactive runs use `gh copilot` and rely on the launch cwd as the worktree boundary.",
      ...(input.mode === "dev"
        ? ["Dev mode currently uses the same Copilot runner shape as full mode."]
        : []),
    ],
  };
}

function buildGeminiMachineFirstPrompt(workUnitId: string, role: TaskAgentRole = "executor"): string {
  const prompt = buildWorkUnitMachineFirstPrompt(workUnitId, role);
  return role === "planner" ? `/plan\n${prompt}` : prompt;
}

export function buildWorkUnitGeminiRuntimeProfile(input: {
  workUnitId: string;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildGeminiMachineFirstPrompt(input.workUnitId, "planner");

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "gemini",
    args: ["-p", prompt, "--output-format", input.ioFormat],
    trustTiers: {
      tierA_controlled: ["project cwd", "inline work-unit prompt", "explicit Gemini CLI launch path"],
      tierB_partial: ["user-scoped Gemini config"],
      tierC_ambient: ["ambient Gemini settings", "global Gemini defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      "Machine is source of truth; Gemini CLI is a stateless planner/orchestrator surface.",
      "Identity is bound to the current workUnitId via the inline work-unit prompt.",
      "The planner-oriented Gemini profile uses native /plan mode semantics before implementation.",
      ...(input.mode === "dev"
        ? ["Dev mode currently uses the same Gemini runner shape as full mode."]
        : []),
    ],
  };
}

export function buildWorkUnitCursorRuntimeProfile(input: {
  workUnitId: string;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId);
  return {
    profile: "work-unit",
    mode: input.mode,
    command: "cursor-agent",
    args: ["--print", "--output-format", input.ioFormat, "--trust", prompt],
    trustTiers: {
      tierA_controlled: ["project cwd", "inline work-unit prompt", "explicit Cursor Agent launch path"],
      tierB_partial: ["user-scoped Cursor Agent config"],
      tierC_ambient: ["ambient Cursor Agent MCP servers", "global Cursor Agent defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      "Machine is source of truth; Cursor Agent is a stateless executor.",
      "Identity is bound to the current workUnitId via the inline work-unit prompt.",
      "Interactive runs use cursor-agent with machine-first --print output in the current worktree.",
      ...(input.mode === "dev"
        ? ["Dev mode currently uses the same Cursor Agent runner shape as full mode."]
        : []),
    ],
  };
}

function buildAllowedToolsForRole(role: TaskAgentRole): string {
  if (role === "planner") {
    return `Read,Bash(${ghSafePath}:*),Bash(${bdSafePath}:*),Bash(${prxSafePath}:*),Bash(${wtSafePath}:*)`;
  }
  if (role === "executor") {
    return `Read,Edit,Bash(${gitSafePath}:*),Bash(${ghSafePath}:*),Bash(${wtSafePath}:*),Bash(${bdSafePath}:*),Bash(${prxSafePath}:*)`;
  }
  if (role === "tester") {
    return `Read,Bash(${ghSafePath}:*),Bash(${wtSafePath}:*),Bash(${prxSafePath}:*),Bash(${gitSafePath}:*)`;
  }
  return `Read,Bash(${ghSafePath}:*),Bash(${prxSafePath}:*),Bash(${gitSafePath}:*)`;
}

function buildClaudeToolsForRole(role: TaskAgentRole): string {
  return role === "executor" ? "Read,Edit,Bash" : "Read,Bash";
}

export function buildTaskRoleClaudeRuntimeProfile(input: {
  agentId?: string;
  workUnitId: string;
  role: TaskAgentRole;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const agentId = input.agentId ?? buildTaskRoleAgentId(input.workUnitId, input.role);
  const fullArgs = [
    "--agents",
    runtimeAgentsPath,
    "--agent",
    agentId,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--mcp-config",
    runtimeMcpPath,
    "--tools",
    buildClaudeToolsForRole(input.role),
    "--allowedTools",
    buildAllowedToolsForRole(input.role),
    "--permission-mode",
    "plan",
    "--json-schema",
    runtimeSchemaPath,
    "--no-session-persistence",
    "--output-format",
    input.ioFormat,
  ];
  const devArgs = [
    "--agent",
    agentId,
    "--tools",
    buildClaudeToolsForRole(input.role),
    "--allowedTools",
    buildAllowedToolsForRole(input.role),
    "--permission-mode",
    "plan",
    "--output-format",
    input.ioFormat,
  ];
  const args = input.mode === "full" ? fullArgs : devArgs;
  if (input.ioFormat === "stream-json") {
    args.push("--input-format", "stream-json");
  }
  return {
    profile: "work-unit",
    mode: input.mode,
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["generated agents", "project/local settings", "project MCP config", "role-scoped wrappers"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "generated",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors, `${input.role}_agent`],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Role-scoped Claude profile for ${input.role}.`,
      "Machine and task contract remain authoritative.",
    ],
  };
}

export function buildTaskRoleCodexRuntimeProfile(input: {
  workUnitId: string;
  role: TaskAgentRole;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId, input.role);
  const interactiveArgs = ["resume", "-s", "workspace-write", "-a", "on-request", input.workUnitId, prompt];
  const freshArgs = ["-s", "workspace-write", "-a", "on-request", prompt];
  return {
    profile: "work-unit",
    mode: input.mode,
    command: "codex",
    args: interactiveArgs,
    fallbackArgs: freshArgs,
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "inline role prompt", "explicit Codex sandbox/approval flags"],
      tierB_partial: ["user-scoped Codex config"],
      tierC_ambient: ["ambient Codex MCP servers", "global Codex defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "codex-config",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors, `${input.role}_agent`],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Role-scoped Codex profile for ${input.role}.`,
      "Machine and task contract remain authoritative.",
    ],
  };
}

export function buildTaskRoleCopilotRuntimeProfile(input: {
  workUnitId: string;
  role: TaskAgentRole;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId, input.role);

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "gh",
    args: ["copilot", "--", "-i", prompt],
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "inline role prompt", "explicit gh copilot launch path"],
      tierB_partial: ["user-scoped Copilot config"],
      tierC_ambient: ["ambient Copilot MCP servers", "global Copilot defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors, `${input.role}_agent`],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Role-scoped Copilot profile for ${input.role}.`,
      "Machine and task contract remain authoritative.",
    ],
  };
}

export function buildTaskRoleGeminiRuntimeProfile(input: {
  workUnitId: string;
  role: TaskAgentRole;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildGeminiMachineFirstPrompt(input.workUnitId, input.role);

  return {
    profile: "work-unit",
    mode: input.mode,
    command: "gemini",
    args: ["-p", prompt, "--output-format", input.ioFormat],
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "inline role prompt", "explicit Gemini CLI launch path"],
      tierB_partial: ["user-scoped Gemini config"],
      tierC_ambient: ["ambient Gemini settings", "global Gemini defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors, `${input.role}_agent`],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Role-scoped Gemini profile for ${input.role}.`,
      input.role === "planner"
        ? "Planner runs through Gemini's native /plan mode before any implementation handoff."
        : "Machine and task contract remain authoritative.",
    ],
  };
}

export function buildTaskRoleCursorRuntimeProfile(input: {
  workUnitId: string;
  role: TaskAgentRole;
  ioFormat: RuntimeIoFormat;
  mode: RuntimeMode;
}): RuntimeProfileProjection {
  const prompt = buildWorkUnitMachineFirstPrompt(input.workUnitId, input.role);
  return {
    profile: "work-unit",
    mode: input.mode,
    command: "cursor-agent",
    args: ["--print", "--output-format", input.ioFormat, "--trust", prompt],
    env: {
      PRX_AGENT_ROLE: input.role,
      ...agentOtelEnv(input.role),
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "inline role prompt", "explicit Cursor Agent launch path"],
      tierB_partial: ["user-scoped Cursor Agent config"],
      tierC_ambient: ["ambient Cursor Agent MCP servers", "global Cursor Agent defaults"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: [...workUnitAllowedActors, `${input.role}_agent`],
    disallowedActors: [...workUnitDisallowedActors],
    notes: [
      `Role-scoped Cursor Agent profile for ${input.role}.`,
      "Machine and task contract remain authoritative.",
    ],
  };
}

export function buildWorkUnitMachineFirstPromptText(workUnitId: string, role: TaskAgentRole = "executor"): string {
  return buildWorkUnitMachineFirstPrompt(workUnitId, role);
}

/**
 * GH-1233: positive-instruction clauses appended to the plan-session system
 * prompt. The `prx plan` profile already denies raw `gh`/`bd`/heredoc writes
 * at the flag layer, but the planner subagent needs to be told *what verbs
 * to call instead* — otherwise it burns turns hitting denials on the wrong
 * shape. Module-internal so the public API surface of `runtime_profiles.ts`
 * stays narrow; tests assert via `buildOpsPlanPrompt` output.
 */
const PLAN_PRIMING_CLAUSES: readonly string[] = [
  "For issue and queue lookups, read with `prx plan view <id|url>` and `prx plan search <query>` — not raw `gh issue view`, `bd show`, or the beads MCP (those are denied at the flag layer; the prx verbs are the canonical issue read path). For code inspection use the allowed `Read`/`Grep`/`Glob` tools, and for cross-actor reads (chain status, contract, repo overview, worktree, …) dispatch — e.g. `prx plan dispatch --actor=chain -- status` — which returns a CAS handle you dereference, since those namespaces are no longer directly runnable from this profile (GH-1530 PR-6).",
  "Persist the plan with `prx plan save --unit <GH-N> --slot draft --from-stdin` (or `--from-file <path>`) — not `ExitPlanMode`, the `Write` tool, or `cat > plan.md << 'EOF'`; pipe the body in via heredoc to `prx plan save` so empty stdin does not produce a zero-byte plan (GH-1237).",
  "For epic-scope or cross-file research that exceeds `prx plan view`/`search` and the in-profile Read/Grep/Glob tools, hand off via scout dispatch (GH-1228) — do not substitute raw `grep -r src` or recursive `find` from this profile.",
  "For repo-inventory needs (file lists, file content, code searches) prefer typed scout dispatch so findings persist as `scout://sha256:<hex>` CAS handles you can quote in the saved plan: `prx plan dispatch --actor=scout -- files <glob>` for file lists, `prx plan dispatch --actor=scout -- read <path>` for a single file's content, and `prx plan dispatch --actor=scout -- grep <pattern>` for code search. Native Read/Glob/Grep stay available for in-context use, but their output cannot be re-quoted by downstream actors (GH-1384).",
];

/**
 * System prompt for the work-unit-bound `prx plan session` (GH-1147). Mirrors
 * the intake/triage pattern: composes the work-unit machine-first scaffolding
 * (planner role) with a textual enumeration of the allowed/disallowed lists
 * sourced from `SESSION_PROFILES.plan`, and a ratchet hint.
 */
export function buildOpsPlanPrompt(workUnitId: string, planPath?: string): string {
  const allowed = SESSION_PROFILES.plan.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.plan.disallowedTools.join(", ");
  const machineFirst = buildWorkUnitMachineFirstPrompt(workUnitId, "planner");
  const lines = [
    machineFirst,
    "You are on the prx plan profile: read/search/inspect only.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
    "Ratchet to Edit/Write is not available inside this session — exit and run `prx implement agent <GH-N>` from a fresh shell to open the executor profile for this work unit.",
    ...PLAN_PRIMING_CLAUSES,
  ];
  // GH-1044: when the operator passed `--plan PATH`, append a directive so the
  // session opens pre-instructed to execute the saved plan after ratcheting.
  if (planPath) {
    lines.push(`Execute the plan at ${planPath}.`);
  }
  return lines.join(" ");
}

/**
 * GH-1172: system prompt for `prx implement agent` sessions. Mirrors the plan
 * profile's prompt shape but with the executor role and a reminder that the
 * implement profile is the writeable counterpart of plan — work stays scoped
 * to the unit, edits go through plan's prior decisions, and the operator
 * exits to plan-mode (read-only) before reopening if scope shifts.
 *
 * GH-1238: when the CLI auto-primes from the saved plan slot, the slot body
 * is injected via `planBody` (mutually exclusive with the GH-1044 `planPath`
 * override).
 *
 * GH-1287: the prompt is no longer truncated. The implement runtime profile
 * delivers it via `--append-system-prompt-file <path>` (primary path) so the
 * full plan body never enters argv, sidestepping the macOS `posix_spawn`
 * `command too long` ceiling. The short fallback prompt for older `claude`
 * binaries (which lack `--append-system-prompt-file`) lives in
 * `buildOpsImplementFallbackPrompt`.
 */
export interface BuildOpsImplementPromptInput {
  workUnitId: string;
  planPath?: string | undefined;
  planBody?: string | undefined;
}

export function buildOpsImplementPrompt(
  input: BuildOpsImplementPromptInput | string,
  legacyPlanPath?: string,
): string {
  // Legacy positional form: buildOpsImplementPrompt("GH-1", "/tmp/plan.md").
  const norm: BuildOpsImplementPromptInput = typeof input === "string"
    ? { workUnitId: input, planPath: legacyPlanPath }
    : input;
  if (norm.planPath && norm.planBody) {
    throw new Error("buildOpsImplementPrompt: planPath and planBody are mutually exclusive");
  }
  const allowed = SESSION_PROFILES.implement.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.implement.disallowedTools.join(", ");
  const machineFirst = buildWorkUnitMachineFirstPrompt(norm.workUnitId, "executor");
  const lines = [
    machineFirst,
    "You are on the prx implement profile: full executor toolset with Edit/Write enabled.",
    "Implement only the already-confirmed scope from the plan; do not widen scope.",
    "Route writes through `prx tools git/gh/bd/wt` wrappers; raw destructive operations (force-push, hard reset, recursive rm) are blocked at the flag layer.",
    "If scope needs to shift, exit to `prx plan session` (read-only) before reopening.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
  ];
  if (norm.planPath) {
    lines.push(`Execute the plan at ${norm.planPath}.`);
  }
  if (norm.planBody) {
    lines.push(
      [
        "Saved plan (slot=draft):",
        "---",
        norm.planBody,
        "---",
        "Execute exactly this plan's § Scope. Do not widen scope. If the plan declares doc-only or comment-only changes, do not touch source code.",
        "Discover the implement surface with `prx implement agent --help`; do not request additional tools unless the plan declares them.",
      ].join("\n"),
    );
  }
  return lines.join(" ");
}

/**
 * GH-1287: short fallback prompt used when the local `claude` binary does
 * not support `--append-system-prompt-file`. Instead of inlining the full
 * plan body into argv (which trips the macOS `posix_spawn` ceiling for plans
 * larger than ~14 KB), the agent is directed to load the plan itself via
 * `prx implement dispatch --actor=plan -- show <id>` on entry (GH-1530 PR-6:
 * the cross-namespace plan read goes through dispatch — covered by the own
 * `prx implement:*` glob — and returns a CAS handle to dereference).
 */
export function buildOpsImplementFallbackPrompt(workUnitId: string): string {
  const allowed = SESSION_PROFILES.implement.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.implement.disallowedTools.join(", ");
  const machineFirst = buildWorkUnitMachineFirstPrompt(workUnitId, "executor");
  return [
    machineFirst,
    "You are on the prx implement profile: full executor toolset with Edit/Write enabled.",
    "Implement only the already-confirmed scope from the plan; do not widen scope.",
    "Route writes through `prx tools git/gh/bd/wt` wrappers; raw destructive operations (force-push, hard reset, recursive rm) are blocked at the flag layer.",
    "If scope needs to shift, exit to `prx plan session` (read-only) before reopening.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
    `On entry, run \`prx implement dispatch --actor=plan -- show ${workUnitId}\` (dereference the returned CAS handle) to load your plan. Execute exactly its § Scope. Do not widen scope. If the plan declares doc-only or comment-only changes, do not touch source code.`,
    "Discover the implement surface with `prx implement agent --help`; do not request additional tools unless the plan declares them.",
  ].join(" ");
}

/**
 * System prompt for the mainx triage operator session (GH-893). Triage is a
 * unit-less ops surface: it sweeps the open-issue queue, dedupes, and
 * promotes execution-ready issues into beads. It explicitly never crosses
 * into execution (no branch, no edit, no PR).
 */
export function buildOpsMainxTriagePrompt(): string {
  const allowed = SESSION_PROFILES.triage.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.triage.disallowedTools.join(", ");
  return [
    "You are the triage operator on mainx.",
    "mainx is the ops surface, not an execution surface — you do not branch, edit code, or open PRs.",
    "Hydrate the live queue with `prx triage dispatch --actor=scout -- issues` (scoped beads/Dolt projection; dereference the returned CAS handle) before each decision.",
    "Search before file: run `prx triage dispatch --actor=intake -- search '<title>'` to detect dupes (unified GH+bd dedupe); merge dupes via a pointer comment ('Merging into #N') and close — never both.",
    "GH issues are the intake log; beads is the execution queue. Promote execution-ready issues with `bd create --external-ref <issue-url>` and apply the matching `priority::*` and `type::*` labels on the GH issue.",
    "Triage does not cross into execution: after promoting an issue, hand off via a fresh `bd show <id>` execution session — do not branch, edit, or open PRs from this window.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
  ].join(" ");
}

/**
 * System prompt for the mainx intake operator session (GH-950). Intake is a
 * unit-less ops surface that pre-triage: search → file-or-merge → mirror →
 * comment. No promotion to beads execution queue, no edits, no branching.
 */
export function buildOpsMainxIntakePrompt(): string {
  const allowed = SESSION_PROFILES.intake.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.intake.disallowedTools.join(", ");
  return [
    "You are the intake operator on mainx.",
    "mainx is the ops surface, not an execution surface — you do not branch, edit code, or open PRs.",
    "Intake is pre-triage: search the GH issue queue and beads, file new issues or merge into existing ones via pointer comment, mirror to beads only when explicitly directed.",
    "File on first observation — never gate filing on recurrence. Triage disposes (close as no-repro, merge as dupe, defer); intake captures the signal.",
    "Search before file: run `prx intake search '<title>'` first (unified GH+bd dedupe); when a real dupe exists, close it into the canonical issue with `prx intake merge` (atomic pointer-comment + close) or leave a pointer with `prx intake comment` — never comment and then close by hand.",
    "Use `prx intake <type>` to file a new issue with the correct shape; do not call `gh issue create` directly when an intake type matches.",
    "Intake does not promote to beads or classify labels — that work belongs to the triage operator; hand off via a fresh `prx triage agent` when appropriate.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
  ].join(" ");
}

/**
 * System prompt for the `prx submit session` operator (GH-1740, work-unit-
 * bound in GH-1900). Submit prepares a CAS-backed submit artifact for the
 * bound unit and hands off to `prx submit publish --from-cas <ref>`. Pre-
 * merge `Closes #N` body staging (`prx submit body-template`) and post-merge
 * orphan sweep (`prx submit postmerge`) remain in scope; the session never
 * branches, edits code, or pushes.
 */
export interface BuildOpsSubmitPromptInput {
  workUnitId: string;
  planPath?: string | undefined;
  planBody?: string | undefined;
}

export function buildOpsSubmitPrompt(input: BuildOpsSubmitPromptInput): string {
  if (input.planPath && input.planBody) {
    throw new Error("buildOpsSubmitPrompt: planPath and planBody are mutually exclusive");
  }
  const allowed = SESSION_PROFILES.submit.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.submit.disallowedTools.join(", ");
  const machineFirst = buildWorkUnitMachineFirstPrompt(input.workUnitId, "executor");
  const lines = [
    machineFirst,
    "You are on the prx submit profile: prep a CAS-backed submit artifact for this work unit, then hand off to `prx submit publish --from-cas <ref>`.",
    "Pipeline: stage the artifact (head ref + patch metadata) under `<UoW>:submit@draft`, promote to `<UoW>:submit@ready` when the work unit is reviewable, then exit — `prx submit publish` runs after the session ends and advances the slot to `<UoW>:submit@published`.",
    "Use `prx submit body-template --closes GH-N` to render the `Closes #N` lines for the PR body; use `prx submit postmerge <pr-number>` only for the post-merge orphan sweep.",
    "Do not edit source code; do not `git push`; do not `gh pr create`. The implementation is already committed; publish runs as a separate step outside the session.",
    "If scope needs to shift, exit to `prx plan session` (read-only) before reopening.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
  ];
  if (input.planPath) {
    lines.push(`Execute the plan at ${input.planPath}.`);
  }
  if (input.planBody) {
    lines.push(
      [
        "Saved plan (slot=draft):",
        "---",
        input.planBody,
        "---",
        "Reflect the plan's § Scope in the submit artifact. Do not widen scope.",
      ].join("\n"),
    );
  }
  return lines.join(" ");
}

type SessionProfilePromptDelivery =
  | { kind: "inline"; prompt: string }
  | { kind: "file"; path: string };

function buildSessionProfileClaudeArgs(input: {
  name: string;
  prompt?: string;
  promptDelivery?: SessionProfilePromptDelivery;
  tools?: { allowed: string[]; disallowed: string[] };
  continueSession?: boolean;
  /**
   * GH-2394: MCP config source. Defaults to the project-scoped runtime MCP
   * file path (`runtimeMcpPath`). Work-unit-UNBOUND profiles (e.g. `scratch`)
   * have no `.pr/local/runtime/mcp.json`, so they pass an inline JSON string
   * (`{"mcpServers":{}}`) here — `--mcp-config` accepts either a path or a
   * literal JSON object.
   */
  mcpConfig?: string;
  /**
   * GH-2394: optional `--settings <path>` for the per-session Claude Code
   * built-in sandbox block. `--settings` merges over `--setting-sources`
   * files (sits just below managed settings in precedence). Absent ⇒ no flag.
   */
  settingsPath?: string;
}): string[] {
  const args: string[] = [
    "--name",
    input.name,
    "--mcp-config",
    input.mcpConfig ?? runtimeMcpPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "plan",
  ];
  // GH-2394: deliver the sandbox settings block before the tool flags so the
  // sandbox layer is legible early in argv. `--settings` is broadly available
  // in claude 2.x; absence of the flag simply means no built-in sandbox.
  if (input.settingsPath) {
    args.push("--settings", input.settingsPath);
  }
  // GH-1147: profiles that opt in pass --allowedTools / --disallowedTools so
  // the constraint is enforced at the Claude flag layer, not just the
  // permission-mode runtime gate (matches the GH-367 tool-visibility principle).
  // Triage relies on prompt + permission-mode and does not pass these flags;
  // the plan and intake profiles do (intake narrowed to `prx intake:*` in GH-1004).
  if (input.tools) {
    args.push("--allowedTools", input.tools.allowed.join(","));
    args.push("--disallowedTools", input.tools.disallowed.join(","));
  }
  // GH-1287: implement-session profiles may deliver the system prompt via a
  // file path (`--append-system-prompt-file <path>`) instead of inlining it
  // into argv, sidestepping the macOS posix_spawn `command too long` (E2BIG)
  // ceiling for large saved-plan blobs. Other profiles still pass `prompt`.
  const delivery: SessionProfilePromptDelivery = input.promptDelivery
    ?? (input.prompt !== undefined
      ? { kind: "inline", prompt: input.prompt }
      : (() => {
          throw new Error(
            "buildSessionProfileClaudeArgs: prompt or promptDelivery is required",
          );
        })());
  if (delivery.kind === "file") {
    args.push("--append-system-prompt-file", delivery.path);
  } else {
    args.push("--append-system-prompt", delivery.prompt);
  }
  if (input.continueSession) {
    args.push("--continue");
  }
  return args;
}

/**
 * Claude runtime profile for `prx triage session` (GH-893). Modelled after
 * `buildWorkUnitClaudeInteractiveRuntimeProfile` but unbound from any
 * GH-N work unit: the operator surface is mainx itself, the system prompt
 * is the triage operator prompt, and there is no role binding.
 *
 * GH-950: allowlist is sourced from `SESSION_PROFILES.triage` (config, not
 * embedded in prompt strings).
 */
export function buildOpsTriageClaudeRuntimeProfile(
  message?: string,
): RuntimeProfileProjection {
  const profile = SESSION_PROFILES.triage;
  const seed = message?.trim();
  const args = buildSessionProfileClaudeArgs({
    name: "mainx-triage",
    // prx-383: a work-unit id seed aims the interactive session at that item.
    prompt: seed
      ? `${buildOpsMainxTriagePrompt()}\n\nTriage this specific work-unit: ${seed}`
      : buildOpsMainxTriagePrompt(),
  });

  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "triage",
    },
    trustTiers: {
      tierA_controlled: ["mainx cwd", "triage operator system prompt", "project MCP config"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    notes: [
      "Ops-triage surface: mainx-bound, work-unit-unbound.",
      "--permission-mode plan keeps the run read-only by default; operator ratchets looser inside claude for gh/bd writes.",
      "Display name is pinned to `mainx-triage` so the prompt-box badge, /resume picker, and terminal title all match.",
      "No --continue: each triage pass is a fresh sweep of the queue.",
      "Allowlist is sourced from SESSION_PROFILES.triage (GH-950).",
    ],
  };
}

/**
 * Claude runtime profile for `prx intake session` (GH-950). Mainx-bound,
 * work-unit-unbound, pre-triage shape: search the queue, file or merge,
 * mirror — no execution, no promotion to beads.
 */
export function buildOpsIntakeClaudeRuntimeProfile(
  message?: string,
): RuntimeProfileProjection {
  const profile = SESSION_PROFILES.intake;
  const seed = message?.trim();
  const args = buildSessionProfileClaudeArgs({
    name: "mainx-intake",
    // prx-28w: a `--message` seed appends the operator's request to the system
    // prompt so the interactive session opens already aimed at that one item.
    prompt: seed
      ? `${buildOpsMainxIntakePrompt()}\n\nOperator request: ${seed}`
      : buildOpsMainxIntakePrompt(),
    tools: {
      allowed: profile.allowedTools,
      disallowed: profile.disallowedTools,
    },
  });

  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "intake",
    },
    trustTiers: {
      tierA_controlled: ["mainx cwd", "intake operator system prompt", "project MCP config", "static intake allowlist"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    notes: [
      "Ops-intake surface: mainx-bound, work-unit-unbound.",
      "--allowedTools / --disallowedTools enforce the toolset at the flag layer (GH-1004); --permission-mode plan remains the runtime gate.",
      "Display name is pinned to `mainx-intake` so the prompt-box badge, /resume picker, and terminal title all match.",
      "No --continue: each intake pass is a fresh sweep.",
      "Allowlist is sourced from SESSION_PROFILES.intake (GH-950, narrowed to `prx intake:*` in GH-1004).",
    ],
  };
}

/**
 * Claude runtime profile for `prx submit session` (GH-1740, work-unit-bound
 * in GH-1900). Renders the submit operator system prompt and enforces the
 * narrow submit allowlist at the flag layer. Mirrors the author profile's
 * shape (work-unit binding, planPath/planBody injection).
 */
export interface BuildOpsSubmitClaudeRuntimeProfileInput {
  workUnitId: string;
  hasPriorSession: boolean;
  planPath?: string | undefined;
  planBody?: string | undefined;
}

export function buildOpsSubmitClaudeRuntimeProfile(
  input: BuildOpsSubmitClaudeRuntimeProfileInput,
): RuntimeProfileProjection {
  if (input.planPath && input.planBody) {
    throw new Error("buildOpsSubmitClaudeRuntimeProfile: planPath and planBody are mutually exclusive");
  }
  const profile = SESSION_PROFILES.submit;
  const args = buildSessionProfileClaudeArgs({
    name: input.workUnitId,
    prompt: buildOpsSubmitPrompt({
      workUnitId: input.workUnitId,
      planPath: input.planPath,
      planBody: input.planBody,
    }),
    tools: {
      allowed: profile.allowedTools,
      disallowed: profile.disallowedTools,
    },
    continueSession: input.hasPriorSession,
  });

  const notes = [
    "Work-unit-bound submit surface: prep CAS artifact + handoff to `prx submit publish` (GH-1900).",
    "--allowedTools / --disallowedTools enforce the toolset at the flag layer (GH-367); --permission-mode plan remains the runtime gate.",
    `Display name is pinned to ${input.workUnitId} so the prompt-box badge, /resume picker, and terminal title match the canonical work-unit id.`,
    input.hasPriorSession
      ? "Resumes the most recent claude conversation for this cwd via --continue."
      : "First-entry launch (no prior claude session saved for this cwd).",
    "Allowlist is sourced from SESSION_PROFILES.submit (GH-1740, narrowed + work-unit-bound in GH-1900).",
    "GH-1900: env exports PRX_SUBMIT_SESSION_UNIT so submit-toolset verbs can infer the active unit without re-passing --unit.",
  ];
  if (input.planPath) {
    notes.push(`Plan injection: appended 'Execute the plan at ${input.planPath}.' to system prompt.`);
  }

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "submit",
      // GH-1900: lets submit-toolset verbs resolve the active unit from
      // inside the submit pane without re-passing `--unit GH-N`. Mirrors
      // `PRX_PLAN_SESSION_UNIT` (GH-1311).
      PRX_SUBMIT_SESSION_UNIT: input.workUnitId,
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "submit operator system prompt", "project MCP config", "static submit allowlist"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    notes,
  };
}

/**
 * Claude runtime profile for `prx plan session` (GH-1147). Work-unit-bound
 * (binds to GH-NNN), mirrors the intake/triage profile-driven shape but adds
 * `--allowedTools` / `--disallowedTools` Claude flags so Edit/Write and
 * destructive Bash are blocked at the toolset layer rather than the
 * permission-mode runtime gate (GH-367 tool-visibility principle).
 *
 * Replaces the prior wiring through `buildWorkUnitClaudeInteractiveRuntimeProfile`
 * with role="executor", which gave the planner the full toolset.
 */
export function buildOpsPlanClaudeRuntimeProfile(input: {
  workUnitId: string;
  hasPriorSession: boolean;
  planPath?: string | undefined;
  /**
   * GH-2014: foreground vs background tmux attach. Carried verbatim onto
   * the projection so the CLI handler can gate `attachMuxSession` on it.
   */
  attachMode?: "foreground" | "background" | undefined;
}): RuntimeProfileProjection {
  const profile = SESSION_PROFILES.plan;
  // GH-1175: carve a Write allowlist out for the plan staging directory so
  // the planner can drop a draft markdown file there for `prx plan save
  // --from-file <staging>/<unit>-<slot>.md`. Cursor trips on heredoc
  // bodies that contain `{...}` + quotes (its expansion-obfuscation
  // heuristic), so `--from-stdin` is unusable from Cursor — `--from-file`
  // is the operator-friendly path. Only the staging dir is opened; bare
  // `Write` is not on the allowlist, so writes elsewhere stay denied.
  //
  // GH-1175 Copilot review: degrade gracefully when neither XDG_CACHE_HOME
  // nor HOME is set. The planner profile should still launch — read/search
  // remains useful — and the absence of the carve-out is surfaced via
  // notes so `--dry-run --format json` makes the missing env var
  // observable. We only swallow the documented NO_STAGING_ROOT case;
  // INVALID_STAGING_ROOT (env contains forbidden chars) and any other
  // unexpected error propagate so callers see real bugs.
  let stagingAllow: string | null = null;
  let stagingNote: string;
  try {
    const staging = resolvePlanStagingDirForDisplay();
    stagingAllow = `Write(${staging.dir}/**)`;
    stagingNote = `Staging carve-out: ${stagingAllow} added to --allowedTools so planner-authored drafts can be written for \`prx plan save --from-file\` (GH-1175, source: ${staging.source}).`;
  } catch (err) {
    if (err instanceof PlanStoreError && err.code === "NO_STAGING_ROOT") {
      stagingNote =
        "Staging carve-out: skipped — neither XDG_CACHE_HOME nor HOME is set. Set one of those env vars to enable `prx plan save --from-file <staging>/...` (GH-1175).";
    } else {
      throw err;
    }
  }
  const allowedWithStaging =
    stagingAllow !== null ? [...profile.allowedTools, stagingAllow] : profile.allowedTools;
  const args = buildSessionProfileClaudeArgs({
    name: input.workUnitId,
    prompt: buildOpsPlanPrompt(input.workUnitId, input.planPath),
    tools: {
      allowed: allowedWithStaging,
      disallowed: profile.disallowedTools,
    },
    continueSession: input.hasPriorSession,
  });

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "planner",
      // GH-1311: lets `prx plan save / load / show / view / search` resolve
      // the active unit from inside the planner pane without `--unit GH-N`.
      // Read by `resolvePlanSessionUnit` in `src/plan-store/session-context.ts`.
      PRX_PLAN_SESSION_UNIT: input.workUnitId,
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "planner system prompt", "project MCP config", "static plan allowlist"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    ...(input.attachMode ? { attachMode: input.attachMode } : {}),
    notes: [
      "Work-unit-bound plan surface: planner role, read/search/inspect only.",
      "--allowedTools / --disallowedTools enforce the toolset at the flag layer (GH-367); --permission-mode plan remains the runtime gate.",
      `Display name is pinned to ${input.workUnitId} so the prompt-box badge, /resume picker, and terminal title match the canonical work-unit id.`,
      input.hasPriorSession
        ? "Resumes the most recent claude conversation for this cwd via --continue."
        : "First-entry launch (no prior claude session saved for this cwd).",
      "Allowlist is sourced from SESSION_PROFILES.plan (GH-1147).",
      "GH-1311: env exports PRX_PLAN_SESSION_UNIT so plan toolset verbs (save / load / show / view / search) infer the active unit without --unit GH-N.",
      stagingNote,
      ...(input.planPath
        ? [`Plan injection: appended 'Execute the plan at ${input.planPath}.' to system prompt (GH-1044).`]
        : []),
    ],
  };
}

/**
 * Claude runtime profile for `prx implement agent` (GH-1172). Work-unit-bound
 * (binds to GH-NNN); mirrors the plan profile's flag-layer enforcement
 * (`--allowedTools` / `--disallowedTools`) but enables Edit/Write for the
 * executor role. Replaces the prior wiring that routed `prx implement`
 * through `OPEN_PLAN_SESSION`, which trapped operators in the read-only
 * plan toolset even though the verb is meant to write code.
 *
 * GH-1287: when a saved-plan body is primed in via `planBody`, the prompt is
 * delivered through `--append-system-prompt-file <path>` (primary path) so
 * the body never enters argv. If the local `claude` binary lacks file-based
 * prompt support, the profile falls back to a short directive that tells the
 * agent to load the plan itself via `prx implement dispatch --actor=plan --
 * show <id>` — argv carries no plan body in either path. Pre-spawn argv-size check throws a structured
 * `ArgvOverflowError` if the assembled args would exceed the safe ceiling,
 * so future regressions surface a named offender instead of `command too
 * long` (E2BIG).
 */
export interface BuildOpsImplementClaudeRuntimeProfileInput {
  workUnitId: string;
  hasPriorSession: boolean;
  planPath?: string | undefined;
  planBody?: string | undefined;
  /**
   * GH-1287: optional injection points so tests (and a future operator
   * override) can pin behaviour without touching the real claude binary or
   * filesystem layout.
   */
  capabilities?: { supportsSystemPromptFile?: boolean };
  /**
   * Repository root used to resolve `.prx/run/<id>/implement-prompt.txt`.
   * Defaults to `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * GH-2014: foreground vs background tmux attach. Carried verbatim onto
   * the projection so the CLI handler can gate `attachMuxSession` on it.
   */
  attachMode?: "foreground" | "background" | undefined;
}

export function buildOpsImplementClaudeRuntimeProfile(
  input: BuildOpsImplementClaudeRuntimeProfileInput,
): RuntimeProfileProjection {
  if (input.planPath && input.planBody) {
    throw new Error("buildOpsImplementClaudeRuntimeProfile: planPath and planBody are mutually exclusive");
  }
  const profile = SESSION_PROFILES.implement;
  const supportsFile = input.capabilities?.supportsSystemPromptFile
    ?? claudeSupportsSystemPromptFile();
  const repoRoot = input.repoRoot ?? process.cwd();

  // GH-1287: choose between the file-based primary path and the in-prompt-fetch
  // fallback. Only the primed-plan-body case triggers the file write; explicit
  // `--plan PATH` (GH-1044) and the no-body case stay on the inline shape since
  // their prompts are bounded.
  const usesFileDelivery = supportsFile && input.planBody !== undefined;
  const usesFallbackPrompt = !supportsFile && input.planBody !== undefined;

  let promptDelivery: SessionProfilePromptDelivery;
  let promptFilePath: string | undefined;
  if (usesFileDelivery) {
    const promptText = buildOpsImplementPrompt({
      workUnitId: input.workUnitId,
      planPath: input.planPath,
      planBody: input.planBody,
    });
    const dir = join(repoRoot, ".prx", "run", input.workUnitId);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "implement-prompt.txt");
    writeFileSync(target, promptText, { encoding: "utf8", mode: 0o644 });
    promptFilePath = target;
    promptDelivery = { kind: "file", path: target };
  } else if (usesFallbackPrompt) {
    promptDelivery = {
      kind: "inline",
      prompt: buildOpsImplementFallbackPrompt(input.workUnitId),
    };
  } else {
    promptDelivery = {
      kind: "inline",
      prompt: buildOpsImplementPrompt({
        workUnitId: input.workUnitId,
        planPath: input.planPath,
        planBody: input.planBody,
      }),
    };
  }

  const args = buildSessionProfileClaudeArgs({
    name: input.workUnitId,
    promptDelivery,
    tools: {
      allowed: profile.allowedTools,
      disallowed: profile.disallowedTools,
    },
    continueSession: input.hasPriorSession,
  });

  // GH-1287: argv-size pre-check. The largest single contributors are the
  // allowlist and (in the inline delivery shape) the system prompt — both are
  // identified by flag so the error names the offender.
  const components: ArgComponent[] = [
    {
      label: "--allowedTools",
      bytes: Buffer.byteLength(profile.allowedTools.join(","), "utf8"),
    },
    {
      label: "--disallowedTools",
      bytes: Buffer.byteLength(profile.disallowedTools.join(","), "utf8"),
    },
    promptDelivery.kind === "file"
      ? {
          label: "--append-system-prompt-file",
          bytes: Buffer.byteLength(promptDelivery.path, "utf8"),
        }
      : {
          label: "--append-system-prompt",
          bytes: Buffer.byteLength(promptDelivery.prompt, "utf8"),
        },
  ];
  assertArgvWithinCeiling(args, components);

  const notes = [
    "Work-unit-bound implement surface: executor role, Edit/Write enabled.",
    "--allowedTools / --disallowedTools enforce the toolset at the flag layer (GH-367); --permission-mode plan remains the runtime gate so the operator must approve write turns.",
    `Display name is pinned to ${input.workUnitId} so the prompt-box badge, /resume picker, and terminal title match the canonical work-unit id.`,
    input.hasPriorSession
      ? "Resumes the most recent claude conversation for this cwd via --continue."
      : "First-entry launch (no prior claude session saved for this cwd).",
    "Allowlist sourced from SESSION_PROFILES.implement; collapsed onto the actor namespace (GH-1238).",
  ];
  if (input.planPath) {
    notes.push(`Plan injection: appended 'Execute the plan at ${input.planPath}.' to system prompt (GH-1044).`);
  }
  if (usesFileDelivery && promptFilePath) {
    notes.push(
      `Plan delivery: system prompt written to ${promptFilePath} and passed via --append-system-prompt-file (GH-1287, primary path).`,
    );
  } else if (usesFallbackPrompt) {
    notes.push(
      `Plan delivery: claude binary lacks --append-system-prompt-file; agent loads plan via \`prx implement dispatch --actor=plan -- show ${input.workUnitId}\` on entry (GH-1287, fallback path).`,
    );
  }

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "executor",
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "executor system prompt", "project MCP config", "static implement allowlist"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    ...(input.attachMode ? { attachMode: input.attachMode } : {}),
    notes,
  };
}

/**
 * System prompt for the `prx author session` operator (GH-1206). Work-unit-
 * bound; takes the implementation diff + saved plan + work-unit issue and
 * walks the operator through writing a reviewable PR body that satisfies the
 * CLAUDE.md PR Standards run-sheet. No source edits; no `git push`.
 */
export interface BuildOpsAuthorPromptInput {
  workUnitId: string;
  planPath?: string | undefined;
  planBody?: string | undefined;
}

export function buildOpsAuthorPrompt(input: BuildOpsAuthorPromptInput): string {
  if (input.planPath && input.planBody) {
    throw new Error("buildOpsAuthorPrompt: planPath and planBody are mutually exclusive");
  }
  const allowed = SESSION_PROFILES.author.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.author.disallowedTools.join(", ");
  const machineFirst = buildWorkUnitMachineFirstPrompt(input.workUnitId, "executor");
  const lines = [
    machineFirst,
    "You are on the prx author profile: PR-body authoring between `implement` and `gc`.",
    "Read the implementation diff + saved plan + work-unit issue, then write a reviewable PR. All PR writes go through the forge actor via dispatch (ai-home-2ow2v): `prx author dispatch --actor=publisher -- pr open|comment|edit`, `--actor=publisher -- ready|draft`; read review threads via `--actor=repo -- pr-comments` (each returns a CAS handle to dereference). Raw gh is denied at the flag layer.",
    "Do not edit source code; do not `git push`; do not merge. The implementation is already committed and pushed.",
    "Walk the CLAUDE.md PR Standards run-sheet (docs/prx/author-runbook.md) and stage the body so each item is verifiable by a reviewer.",
    "Use `prx author body-template --unit <id>` to render the deterministic skeleton; `Refs <bd-id>` follows the #1767 convention (no `Closes` for bd ids).",
    "If scope needs to shift, exit to `prx plan session` (read-only) before reopening.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
  ];
  if (input.planPath) {
    lines.push(`Execute the plan at ${input.planPath}.`);
  }
  if (input.planBody) {
    lines.push(
      [
        "Saved plan (slot=draft):",
        "---",
        input.planBody,
        "---",
        "Reflect the plan's § Scope in the PR body. Do not widen scope.",
      ].join("\n"),
    );
  }
  return lines.join(" ");
}

/**
 * Claude runtime profile for `prx author session` (GH-1206). Work-unit-bound;
 * mirrors `prx implement agent` argv shape but swaps the executor allowlist
 * for the narrow read+gh-pr-only author surface defined in
 * `SESSION_PROFILES.author`.
 */
export interface BuildOpsAuthorClaudeRuntimeProfileInput {
  workUnitId: string;
  hasPriorSession: boolean;
  planPath?: string | undefined;
  planBody?: string | undefined;
}

export function buildOpsAuthorClaudeRuntimeProfile(
  input: BuildOpsAuthorClaudeRuntimeProfileInput,
): RuntimeProfileProjection {
  if (input.planPath && input.planBody) {
    throw new Error("buildOpsAuthorClaudeRuntimeProfile: planPath and planBody are mutually exclusive");
  }
  const profile = SESSION_PROFILES.author;
  const args = buildSessionProfileClaudeArgs({
    name: `${input.workUnitId}-author`,
    prompt: buildOpsAuthorPrompt({
      workUnitId: input.workUnitId,
      planPath: input.planPath,
      planBody: input.planBody,
    }),
    tools: {
      allowed: profile.allowedTools,
      disallowed: profile.disallowedTools,
    },
    continueSession: input.hasPriorSession,
  });

  const notes = [
    "Work-unit-bound author surface: PR-body authoring profile between implement and gc.",
    "--allowedTools / --disallowedTools enforce the toolset at the flag layer (GH-367); --permission-mode plan remains the runtime gate.",
    `Display name is pinned to ${input.workUnitId}-author so the prompt-box badge, /resume picker, and terminal title match.`,
    input.hasPriorSession
      ? "Resumes the most recent claude conversation for this cwd via --continue."
      : "First-entry launch (no prior claude session saved for this cwd).",
    "Allowlist sourced from SESSION_PROFILES.author (GH-1206); read+gh-pr-only — no Edit/Write on source, no git push, no gh pr merge.",
  ];
  if (input.planPath) {
    notes.push(`Plan injection: appended 'Execute the plan at ${input.planPath}.' to system prompt.`);
  }

  return {
    profile: "work-unit",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "author",
    },
    trustTiers: {
      tierA_controlled: ["project cwd", "author system prompt", "project MCP config", "static author allowlist"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads", "worktrunk"],
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    notes,
  };
}


/**
 * GH-2394: default network allowlist for the scratch sandbox. Kept minimal —
 * just the Anthropic API + telemetry endpoints the model needs to function —
 * and documented in docs/prx/scratch-runbook.md so it can be widened
 * deliberately. Too tight breaks the model call; too loose defeats the jail.
 */
export const SCRATCH_SANDBOX_ALLOWED_DOMAINS = [
  "api.anthropic.com",
  "statsig.anthropic.com",
] as const;

/** GH-2394: fixed filename for the per-session scratch sandbox settings. */
const scratchSandboxSettingsFilename = "scratch-sandbox.settings.json";

/**
 * GH-2394: shape of the Claude Code built-in sandbox settings written for a
 * safe-mode scratch session. Seatbelt-backed on macOS; delivered via
 * `--settings <path>`. `allowUnsandboxedCommands:false` is strict mode (no
 * unsandboxed retry; `dangerouslyDisableSandbox` is ignored).
 */
export function buildScratchSandboxSettings(cwd: string): {
  sandbox: {
    enabled: boolean;
    failIfUnavailable: boolean;
    allowUnsandboxedCommands: boolean;
    filesystem: { allowWrite: string[] };
    network: { allowedDomains: string[]; allowManagedDomainsOnly: boolean };
  };
} {
  return {
    sandbox: {
      enabled: true,
      // Refuse to launch if seatbelt is unavailable (non-macOS, or disabled).
      // Acceptable for a safe-by-default macOS profile; Linux/bubblewrap
      // parity is a named follow-up (out of scope for GH-2394).
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [cwd, "$TMPDIR"] },
      network: {
        allowedDomains: [...SCRATCH_SANDBOX_ALLOWED_DOMAINS],
        allowManagedDomainsOnly: false,
      },
    },
  };
}

/**
 * GH-2394: resolve the on-disk path for the scratch sandbox settings file.
 * Prefers the project runtime dir (`<cwd>/.pr/local/runtime/`) when it exists
 * so the file lives alongside the other runtime artifacts (idempotent — the
 * filename is fixed, so re-launching scratch in the same cwd overwrites rather
 * than clutters).
 *
 * Without a project runtime dir it falls back to a private, per-invocation
 * temp directory created with `mkdtempSync` (mode 0700, unguessable name)
 * rather than a predictable `$TMPDIR/prx-<fixed>` path. A fixed name in the
 * shared OS temp dir is open to symlink / pre-creation hijacking (CodeQL
 * js/insecure-temporary-file); the trade-off is that the fallback no longer
 * overwrites in place, but the project-runtime-dir path — the common case —
 * keeps its idempotency.
 */
export function resolveScratchSandboxSettingsPath(cwd: string): string {
  const runtimeDir = join(cwd, ".pr", "local", "runtime");
  if (existsSync(runtimeDir)) {
    return join(runtimeDir, scratchSandboxSettingsFilename);
  }
  return join(mkdtempSync(join(tmpdir(), "prx-scratch-")), scratchSandboxSettingsFilename);
}

/**
 * GH-2394: write the scratch sandbox settings JSON to disk and return its
 * path. The builder calls this so the projection's `--settings <path>` arg
 * points at a live file. Writing during projection build is intentional here
 * (the plan calls for the builder to return the path it wrote).
 */
export function writeScratchSandboxSettings(cwd: string): string {
  const path = resolveScratchSandboxSettingsPath(cwd);
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(buildScratchSandboxSettings(cwd), null, 2)}\n`);
  return path;
}

/**
 * GH-2394: system prompt for the `prx scratch` session. Documents the
 * safe-by-default contract (the three layers) and that `--unsafe` is the only
 * escalation — surfaced in-session so the operator sees the boundary they are
 * working inside.
 */
export function buildOpsScratchPrompt(unsafe: boolean): string {
  if (unsafe) {
    return [
      "You are in an UNSAFE scratch session (`prx scratch --unsafe`).",
      "This is the documented escape hatch: ambient authority is restored — every tool is live, the claude.ai account connectors (Notion/Google/computer-use) are mounted, and there is no OS sandbox.",
      "There is no work-unit binding and no enforced scope. Treat this as a raw `claude` session.",
    ].join(" ");
  }
  const allowed = SESSION_PROFILES.scratch.allowedTools.join(", ");
  const disallowed = SESSION_PROFILES.scratch.disallowedTools.join(", ");
  return [
    "You are in a safe-by-default scratch session (`prx scratch`).",
    "This is a least-privilege, work-unit-UNBOUND ad-hoc session. Three safety layers are active:",
    "(1) permission flag-layer — read-only by default (`--permission-mode plan`) with a strict tool allowlist;",
    "(2) MCP lockdown — no project or claude.ai connectors (the Notion/Google/computer-use account connectors are killed via ENABLE_CLAUDEAI_MCP_SERVERS=false);",
    "(3) OS sandbox — writes are jailed to the current directory and $TMPDIR, and the network is restricted to a minimal allowlist.",
    `Allowed tools: ${allowed}.`,
    `Disallowed tools: ${disallowed}.`,
    "These constraints bound only this prx-launched session; they cannot stop a raw `claude` invocation. To restore ambient authority, exit and relaunch with `prx scratch --unsafe`.",
  ].join(" ");
}

/**
 * GH-2394: Claude runtime profile for `prx scratch` — an ad-hoc,
 * work-unit-UNBOUND session that is safe by default with a single `--unsafe`
 * escape hatch.
 *
 * Safe mode (default) layers three independent boundaries:
 *   1. permission flag-layer — `--permission-mode plan` + the strict scratch
 *      allow/deny tool lists from SESSION_PROFILES.scratch;
 *   2. MCP lockdown — `--strict-mcp-config` + an inline empty MCP map (scratch
 *      is unbound, so there is no `.pr/local/runtime/mcp.json` to point at) +
 *      `ENABLE_CLAUDEAI_MCP_SERVERS=false` to kill the claude.ai connectors;
 *   3. OS sandbox — Claude Code's built-in seatbelt sandbox delivered via
 *      `--settings <path>` (FS jailed to cwd + $TMPDIR, minimal network
 *      allowlist, `allowUnsandboxedCommands:false`).
 *
 * `--unsafe` returns a minimal ambient projection (just `--name scratch`, no
 * permission/allowlist/strict-mcp/settings flags, no connector kill-switch).
 */
export interface BuildOpsScratchClaudeRuntimeProfileInput {
  /** Launch directory resolved at dispatch time; the sandbox FS jail root. */
  cwd: string;
  /** Escape hatch back to ambient authority. Defaults to false (safe mode). */
  unsafe?: boolean | undefined;
  /** Resume the most recent claude conversation for this cwd via --continue. */
  hasPriorSession?: boolean | undefined;
}

export function buildOpsScratchClaudeRuntimeProfile(
  input: BuildOpsScratchClaudeRuntimeProfileInput,
): RuntimeProfileProjection {
  const profile = SESSION_PROFILES.scratch;
  const unsafe = input.unsafe ?? false;

  if (unsafe) {
    // Escape hatch: minimal ambient projection. No permission-mode, no
    // allowlist, no strict-mcp, no sandbox settings, and crucially NO
    // ENABLE_CLAUDEAI_MCP_SERVERS env — the claude.ai connectors stay mounted.
    const args = ["--name", "scratch"];
    if (input.hasPriorSession) {
      args.push("--continue");
    }
    args.push("--append-system-prompt", buildOpsScratchPrompt(true));
    return {
      profile: "user",
      mode: "dev",
      command: "claude",
      args,
      // No env kill-switch: ambient authority is intentional here.
      env: {
        PRX_AGENT_ROLE: "scratch",
      },
      trustTiers: {
        tierA_controlled: ["scratch cwd", "scratch operator system prompt"],
        tierB_partial: ["user-scoped MCP entries", "project MCP config"],
        tierC_ambient: ["claude.ai connectors", "built-in agents", "full tool surface", "no OS sandbox"],
      },
      sourcesOfTruth: {
        agents: "inline_prompt",
        mcp: "project-only",
        plugins: [],
        connectors: ["claude.ai account connectors"],
      },
      allowedActors: [...profile.allowedActors],
      disallowedActors: [...profile.disallowedActors],
      notes: [
        "UNSAFE scratch session (`prx scratch --unsafe`): restores ambient authority.",
        "No --permission-mode / --allowedTools / --strict-mcp-config / --settings flags.",
        "No ENABLE_CLAUDEAI_MCP_SERVERS env — the claude.ai connectors (Notion/Google/computer-use) stay mounted; there is no OS sandbox.",
        "This is the documented escape hatch from the safe-by-default `prx scratch` profile.",
        input.hasPriorSession
          ? "Resumes the most recent claude conversation for this cwd via --continue."
          : "First-entry launch (no prior claude session saved for this cwd).",
      ],
    };
  }

  // Safe mode (default): three layers, all on.
  const settingsPath = writeScratchSandboxSettings(input.cwd);
  const args = buildSessionProfileClaudeArgs({
    name: "scratch",
    prompt: buildOpsScratchPrompt(false),
    tools: {
      allowed: profile.allowedTools,
      disallowed: profile.disallowedTools,
    },
    // Scratch is unbound — there is no `.pr/local/runtime/mcp.json`. Pass an
    // inline empty MCP map so `--strict-mcp-config` has a config to lock to.
    mcpConfig: JSON.stringify({ mcpServers: {} }),
    settingsPath,
    continueSession: input.hasPriorSession ?? false,
  });

  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: "scratch",
      // GH-2394: the ONLY switch that kills the claude.ai account connectors
      // (Notion/Google/computer-use). `--strict-mcp-config` does NOT block
      // them. Set on the projection env so it is exported into the spawn env
      // BEFORE claude reads connectors (parity with PRX_AGENT_ROLE).
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    trustTiers: {
      tierA_controlled: [
        "scratch cwd",
        "scratch operator system prompt",
        "inline empty MCP config",
        "static scratch allowlist",
        "macOS sandbox settings",
      ],
      tierB_partial: [],
      tierC_ambient: [],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      // Connectors are killed via ENABLE_CLAUDEAI_MCP_SERVERS=false.
      connectors: [],
    },
    allowedActors: [...profile.allowedActors],
    disallowedActors: [...profile.disallowedActors],
    notes: [
      "Safe-by-default scratch surface: ad-hoc, work-unit-UNBOUND, least-privilege.",
      "Layer 1 (permission): --permission-mode plan + strict --allowedTools (Read/Grep/Glob/Bash(prx:*)) + explicit denies sourced from SESSION_PROFILES.scratch.",
      "Layer 2 (MCP): --strict-mcp-config + inline empty MCP map + env ENABLE_CLAUDEAI_MCP_SERVERS=false (kills the claude.ai connectors — the only switch that does).",
      `Layer 3 (sandbox): Claude Code built-in seatbelt sandbox via --settings ${settingsPath}; FS jailed to cwd + $TMPDIR, network allowlist [${SCRATCH_SANDBOX_ALLOWED_DOMAINS.join(", ")}], allowUnsandboxedCommands:false.`,
      "Advisory-only: these flags bound a prx-launched session; they cannot stop a raw `claude`. System-wide enforcement is the managed-settings floor (#2399).",
      "`prx scratch --unsafe` is the single escape hatch back to ambient authority.",
      input.hasPriorSession
        ? "Resumes the most recent claude conversation for this cwd via --continue."
        : "First-entry launch (no prior claude session saved for this cwd).",
    ],
  };
}

/**
 * GH-2380 — shared headless SDK builder for the four ops session profiles
 * (intake, triage, submit, author). The SDK counterpart to the interactive
 * `buildOps*ClaudeRuntimeProfile` builders: an autonomous claude run via the
 * Agent SDK, selected when the verb is NOT given `--interactive` (headless-
 * first ADR step 2/2b). Mirrors `buildWorkUnitClaudeImplementSdkRuntimeProfile`
 * but with a read/inspect posture (`permissionMode: "plan"` — none of these
 * four edit source).
 *
 * Authority posture (the reviewable security knob): the profile's
 * `sdkSpec.allowedTools`/`disallowedTools` are carried verbatim from
 * `SESSION_PROFILES[name]`, so the headless run is bounded by the exact same
 * declared toolset as the interactive session. Non-allowlisted tools have no
 * headless approval path (no TTY); the deny list survives as explicit intent;
 * and the underlying capability calls stay `@bounded-systems/policy`-gated
 * regardless (ADR §1/§5).
 */
function buildSessionProfileSdkRuntimeProfile(input: {
  name: SessionProfileName;
  role: string;
  systemPrompt: string;
  userPrompt: string;
  env?: Record<string, string> | undefined;
}): RuntimeProfileProjection {
  const cfg = SESSION_PROFILES[input.name];
  const allowedTools = [...cfg.allowedTools];
  const disallowedTools = [...cfg.disallowedTools];
  // Legacy `--print` argv preserved for dry-run readability + operator
  // observability; `executeAgentProfile` reads `sdkSpec`, not this argv.
  const args = [
    "--print",
    "--output-format",
    "json",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    allowedTools.join(","),
    "--disallowedTools",
    disallowedTools.join(","),
    "--append-system-prompt",
    input.systemPrompt,
    input.userPrompt,
  ];

  return {
    profile: cfg.binding === "work-unit" ? "work-unit" : "user",
    mode: "dev",
    command: "claude",
    args,
    env: {
      PRX_AGENT_ROLE: input.role,
      ...(input.env ?? {}),
    },
    agentRuntime: "sdk",
    interaction: "headless",
    sdkSpec: {
      prompt: input.userPrompt,
      systemPromptStable: [input.systemPrompt],
      // prx-hz1: headless agents run with NO human in the loop. `plan` mode
      // produces a plan and then BLOCKS on ExitPlanMode approval that never
      // comes → the SDK conversation hangs forever. `acceptEdits` lets the
      // autonomous run proceed and terminate; the allow/deny lists below (and
      // the @bounded-systems/policy gate) remain the authority boundary, not the
      // permission prompt. Mirrors the implement profile's headless posture.
      permissionMode: "acceptEdits",
      allowedTools,
      disallowedTools,
      strictMcpConfig: true,
      settingSources: ["project", "local"],
    },
    trustTiers: {
      tierA_controlled: [
        cfg.binding === "work-unit" ? "project cwd" : "mainx cwd",
        `${input.name} system prompt`,
        `static ${input.name} allowlist`,
        "project MCP config",
      ],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: ["beads"],
      connectors: [],
    },
    allowedActors: [...cfg.allowedActors],
    disallowedActors: [...cfg.disallowedActors],
    notes: [
      `Headless ${input.name} surface: autonomous SDK run (headless-first step 2, GH-2380). Default; selected when the verb is not given --interactive.`,
      "permissionMode=acceptEdits (prx-hz1): a headless run has no operator to approve prompts, so `plan` mode would hang on ExitPlanMode forever. The SDK allowlist/denylist mirror SESSION_PROFILES verbatim and ARE the authority boundary; non-allowlisted tools are simply unavailable. Underlying capability calls stay @bounded-systems/policy-gated.",
      "GH-1828: routes through the Anthropic Agent SDK (claude_sdk implementation); typed cancellation, partial capture, usage telemetry. Legacy argv preserved for dry-run.",
    ],
  };
}

/**
 * prx-28w: the intake operator's task prompt. With a `--message` seed, intake
 * THAT one item (dedupe → file-or-merge); without one, sweep the whole queue.
 */
export function intakeUserPrompt(message?: string): string {
  const seed = message?.trim();
  if (seed) {
    return (
      `The operator reports: "${seed}". Intake this specific item. First ` +
      "dedupe-search the queue. If a real duplicate exists, merge/pointer-comment " +
      "it. Otherwise file the correctly-typed issue (bug | task | feature | spike " +
      "| decision) with a clear title + body, then mirror it to a bead with " +
      "`prx intake mirror` so the work-unit exists beads-first. " +
      "FINALLY you MUST report the outcome with the result tool — exactly one of:\n" +
      "  prx intake result --disposition filed --uow <bd-id>\n" +
      "  prx intake result --disposition merged --uow <canonical-bd-id> --reason \"<why>\"\n" +
      "  prx intake result --disposition duplicate --uow <existing-bd-id> --reason \"<why>\"\n" +
      "  prx intake result --disposition no_action --reason \"<why nothing was filed>\"\n" +
      "Do not ask clarifying questions."
    );
  }
  return (
    "Run the intake pass headlessly: search the queue, file new issues or merge " +
    "dupes, mirror as directed. Do not ask clarifying questions."
  );
}

/**
 * GH-2380 — headless SDK profile for `prx intake agent` (default). Mainx-bound,
 * work-unit-unbound. SDK counterpart to `buildOpsIntakeClaudeRuntimeProfile`.
 * prx-28w: an optional `--message` seeds the intake to one specific item.
 */
export function buildOpsIntakeSdkRuntimeProfile(
  message?: string,
): RuntimeProfileProjection {
  return buildSessionProfileSdkRuntimeProfile({
    name: "intake",
    role: "intake",
    systemPrompt: buildOpsMainxIntakePrompt(),
    userPrompt: intakeUserPrompt(message),
  });
}

/**
 * prx-383: the triage task prompt. With a work-unit id seed, triage THAT item;
 * without one, sweep the queue.
 */
export function triageUserPrompt(unit?: string): string {
  const seed = unit?.trim();
  if (seed) {
    return (
      `Triage the specific work-unit ${seed}: classify it (type + axes), dedupe ` +
      "it against the queue, and promote it to execution-ready if appropriate.\n" +
      "FINALLY you MUST report the outcome with the result tool — exactly one of:\n" +
      `  prx triage result --disposition classified --uow ${seed} --reason "<type/axes set>"\n` +
      `  prx triage result --disposition promoted --uow ${seed} --reason "<now execution-ready>"\n` +
      `  prx triage result --disposition deferred --uow ${seed} --reason "<why deferred>"\n` +
      "  prx triage result --disposition merged --uow <canonical-bd-id> --reason \"<why>\"\n" +
      "  prx triage result --disposition no_action --reason \"<why nothing changed>\"\n" +
      "Do not ask clarifying questions."
    );
  }
  return (
    "Run the triage pass headlessly: hydrate the queue, dedupe, and promote " +
    "execution-ready issues. Do not ask clarifying questions."
  );
}

/**
 * GH-2380 — headless SDK profile for `prx triage agent` (default). Mainx-bound,
 * work-unit-unbound. SDK counterpart to `buildOpsTriageClaudeRuntimeProfile`.
 * prx-383: an optional work-unit id seeds triage to one item.
 */
export function buildOpsTriageSdkRuntimeProfile(
  message?: string,
): RuntimeProfileProjection {
  return buildSessionProfileSdkRuntimeProfile({
    name: "triage",
    role: "triage",
    systemPrompt: buildOpsMainxTriagePrompt(),
    userPrompt: triageUserPrompt(message),
  });
}

/**
 * GH-2380 — headless SDK profile for `prx submit agent <id>` (default).
 * Work-unit-bound. SDK counterpart to `buildOpsSubmitClaudeRuntimeProfile`.
 */
export function buildOpsSubmitSdkRuntimeProfile(
  input: BuildOpsSubmitPromptInput,
): RuntimeProfileProjection {
  return buildSessionProfileSdkRuntimeProfile({
    name: "submit",
    role: "submit",
    systemPrompt: buildOpsSubmitPrompt(input),
    userPrompt: `Prepare the CAS-backed submit artifact for ${input.workUnitId} headlessly. Do not ask clarifying questions.`,
    // GH-1900 parity: lets submit-toolset verbs resolve the active unit
    // without re-passing --unit GH-N (mirrors the interactive builder).
    env: { PRX_SUBMIT_SESSION_UNIT: input.workUnitId },
  });
}

/**
 * GH-2380 — headless SDK profile for `prx author agent <id>` (default).
 * Work-unit-bound. SDK counterpart to `buildOpsAuthorClaudeRuntimeProfile`.
 */
export function buildOpsAuthorSdkRuntimeProfile(
  input: BuildOpsAuthorPromptInput,
): RuntimeProfileProjection {
  return buildSessionProfileSdkRuntimeProfile({
    name: "author",
    role: "author",
    systemPrompt: buildOpsAuthorPrompt(input),
    userPrompt: `Author the PR body for ${input.workUnitId} headlessly. Do not ask clarifying questions.`,
  });
}

export function getLocalRuntimeArtifactPaths(): {
  agentsPath: string;
  mcpPath: string;
  schemaPath: string;
  bootstrapPath: string;
} {
  return {
    agentsPath: runtimeAgentsPath,
    mcpPath: runtimeMcpPath,
    schemaPath: runtimeSchemaPath,
    bootstrapPath: runtimeBootstrapPath,
  };
}

export function buildUserClaudeRuntimeProfile(): RuntimeProfileProjection {
  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args: [],
    trustTiers: {
      tierA_controlled: [],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors", "built-in agents"],
    },
    sourcesOfTruth: {
      agents: "generated",
      mcp: "project-only",
      plugins: [],
      connectors: ["claude.ai:notion", "claude.ai:gmail", "claude.ai:gcal"],
    },
    allowedActors: ["*"],
    disallowedActors: [],
    notes: [
      "Broad interactive profile for ad-hoc usage.",
      "Not suitable as deterministic work-unit execution surface.",
    ],
  };
}

// ── GH-1828: non-interactive probe / classifier profile builders ───────────
//
// Three new non-interactive surfaces converge onto the SDK transport in
// GH-1828: the triage Haiku classifier (was `defaultSpawnHaiku` in
// `src/triage/type-pass.ts`), the Notion preflight probe (was a `runner`
// spawn at `src/tools/preflight_notion_mcp.ts:67–82`), and the agent-doctor
// claude probe (`src/tools/agent_doctor.ts:120–168`). All three were direct
// direct `claude` subprocess calls; promoting them into the runtime-profile
// surface means they share the same dispatch path as plan-print and are
// inspectable via `prx runtime-profile`.

/**
 * GH-1828: triage type-pass / classify profile. Replaces the inline
 * `defaultSpawnHaiku` spawn at `src/triage/type-pass.ts:246–266`. The Haiku
 * model + system prompt + user prompt come from the caller (per-batch); this
 * builder is shape-only.
 */
export function buildTriageHaikuClassifierRuntimeProfile(input: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): RuntimeProfileProjection {
  const args = [
    "--print",
    "--model",
    input.model,
    "--output-format",
    "json",
    "--append-system-prompt",
    input.systemPrompt,
    input.userPrompt,
  ];
  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    agentRuntime: "sdk",
    sdkSpec: {
      prompt: input.userPrompt,
      // GH-1407 — the type-pass system prompt is a per-batch constant (the
      // caller passes TYPE_PASS_SYSTEM_PROMPT verbatim), so the whole thing
      // is cache-stable. The per-batch `userPrompt` lives in `sdkSpec.prompt`
      // (user message) and is therefore not subject to the system-prompt
      // cache boundary.
      systemPromptStable: [input.systemPrompt],
      model: input.model,
    },
    trustTiers: {
      tierA_controlled: ["triage type-pass system prompt", "Haiku classifier vocabulary"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: ["llm_agent"],
    disallowedActors: ["gmail", "gcal"],
    notes: [
      "GH-1828: non-interactive Haiku batch classifier. SDK-routed (claude_sdk implementation).",
      "Output is the canonical Claude JSON envelope; the caller parses via parseClaudeJsonEnvelope/parseHaikuEnvelope.",
    ],
  };
}

/**
 * GH-1828: Notion preflight probe profile. Replaces the inline `runner` spawn
 * at `src/tools/preflight_notion_mcp.ts:67–82`. OAuth-URL detection stays
 * content-based (the SDK transport doesn't change what claude prints).
 */
export function buildNotionPreflightProbeRuntimeProfile(input: {
  model: string;
  prompt: string;
}): RuntimeProfileProjection {
  const args = [
    "claude",
    "--print",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--permission-mode",
    "dontAsk",
    input.prompt,
  ];
  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    agentRuntime: "sdk",
    sdkSpec: {
      prompt: input.prompt,
      model: input.model,
      permissionMode: "dontAsk",
    },
    trustTiers: {
      tierA_controlled: ["notion-mcp preflight prompt"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: ["llm_agent", "notion_mcp"],
    disallowedActors: ["gmail", "gcal"],
    notes: [
      "GH-1828: non-interactive Notion-MCP probe. SDK-routed (claude_sdk implementation).",
      "Headless-OAuth detection remains content-based — same OAuth URL pattern works regardless of transport.",
    ],
  };
}

/**
 * GH-1828: agent-doctor claude probe profile. Replaces the claude case of
 * `agent_doctor.ts:probeDefinitions()`. Other agents (codex, gemini,
 * cursor-agent, gh-copilot) stay on `spawnCapture` — only the claude probe
 * migrates.
 */
export function buildAgentDoctorClaudeProbeRuntimeProfile(input: {
  model: string;
  prompt: string;
}): RuntimeProfileProjection {
  const args = [
    "claude",
    "--print",
    "--permission-mode",
    "dontAsk",
    "--model",
    input.model,
    "--output-format",
    "json",
    input.prompt,
  ];
  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args,
    agentRuntime: "sdk",
    sdkSpec: {
      prompt: input.prompt,
      model: input.model,
      permissionMode: "dontAsk",
    },
    trustTiers: {
      tierA_controlled: ["agent-doctor probe prompt"],
      tierB_partial: ["user-scoped MCP entries"],
      tierC_ambient: ["claude.ai connectors"],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: ["llm_agent"],
    disallowedActors: ["gmail", "gcal"],
    notes: [
      "GH-1828: non-interactive agent-doctor claude probe. SDK-routed (claude_sdk implementation).",
      "Used by `prx doctor agents`; healthy-when usage is non-empty plus result.subtype=success.",
    ],
  };
}
