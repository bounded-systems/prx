// GH-1821 — AgentContract instances (5 task-role agents + 6 session profiles).
//
// Every agent is strictly 1-input-artifact → 1-output-artifact. Multi-input
// agents (executor/tester/reviewer) take a *composite* artifact registered
// in artifacts.ts with `composedOf:` so the multi-arg shape is recoverable
// via currying without breaking the 1→1 invariant.
//
// `capabilities` / `forbidden` carry the operator-visible tool surfaces from
// SESSION_PROFILES so a contract can be projected back to a profile entry
// without loss (round-trip parity is enforced by the contracts test).

import { agentContractSchema, type AgentContract } from "../contracts.ts";
import { defaultDispatchCapabilities, type DispatchActor } from "../dispatch.ts";
import {
  SESSION_PROFILES,
  type SessionProfileName,
  sessionProfileNames,
  type TaskAgentRole,
  taskAgentRoles,
} from "../runtime_profiles.ts";

// ── task-role agent contracts ─────────────────────────────────────────────

const taskRoleContracts: Record<TaskAgentRole, AgentContract> = {
  planner: agentContractSchema.parse({
    role: "planner",
    inputArtifact: "uow",
    outputArtifact: "plan",
    capabilities: ["plan", "scope", "confirm_success_criteria"],
    forbidden: ["edit_source", "git_push"],
  }),
  executor: agentContractSchema.parse({
    role: "executor",
    inputArtifact: "executor_input_bundle",
    outputArtifact: "patch_proposal",
    capabilities: ["implement", "revise"],
    forbidden: ["git_push_force", "git_reset_hard"],
  }),
  tester: agentContractSchema.parse({
    role: "tester",
    inputArtifact: "tester_input_bundle",
    outputArtifact: "test_run",
    capabilities: ["run_tests", "diagnose_failures"],
    forbidden: ["edit_source", "git_push"],
  }),
  scout: agentContractSchema.parse({
    role: "scout",
    inputArtifact: "query",
    outputArtifact: "scout_result",
    capabilities: ["read", "search"],
    forbidden: ["edit_source", "git_push", "dispatch"],
  }),
  reviewer: agentContractSchema.parse({
    role: "reviewer",
    inputArtifact: "reviewer_input_bundle",
    outputArtifact: "review_bundle",
    capabilities: ["review", "approve_or_reject"],
    forbidden: ["edit_source", "git_push"],
  }),
  // GH-1822: lifecycle-axis management roles. Each is 1→1 over the
  // lifecycle artifacts registered in `./artifacts.ts`; the live Zod
  // schemas for status_update / blocker_report / delegation_record /
  // sprint_plan live in `./lifecycle_artifacts.ts`, while work_map and
  // retro_note remain deferred placeholders for follow-up shards.
  map: agentContractSchema.parse({
    role: "map",
    inputArtifact: "uow",
    outputArtifact: "work_map",
    capabilities: ["decompose", "draw_dependencies"],
    forbidden: ["edit_source", "git_push"],
  }),
  delegate: agentContractSchema.parse({
    role: "delegate",
    inputArtifact: "work_map",
    outputArtifact: "delegation_record",
    capabilities: ["assign", "publish_delegation"],
    forbidden: ["edit_source", "git_push"],
  }),
  report: agentContractSchema.parse({
    role: "report",
    inputArtifact: "uow",
    outputArtifact: "status_update",
    capabilities: ["summarize", "publish_status"],
    forbidden: ["edit_source", "git_push"],
  }),
  retro: agentContractSchema.parse({
    role: "retro",
    inputArtifact: "sprint_plan",
    outputArtifact: "retro_note",
    capabilities: ["reflect", "propose_process_change"],
    forbidden: ["edit_source", "git_push"],
  }),
  // GH-2326: gc (unified housekeeping) role — headless-first, off the linear
  // uow→pr pipeline. 1→1 over uow → gc_report (the reclaim/teardown result).
  // Per operator steer 2026-05-27 gc is a role spec, NOT a SESSION_PROFILES
  // entry; the destructive authority boundary is the GC_DELETE_CAPABILITY
  // token + mark→sweep contract in src/machine/gc/capability.ts, surfaced via
  // the capability-gated `prx gc {inventory,run,teardown}` verbs (GH-2327).
  gc: agentContractSchema.parse({
    role: "gc",
    inputArtifact: "uow",
    outputArtifact: "gc_report",
    capabilities: ["inventory", "reclaim", "teardown"],
    forbidden: ["edit_source", "git_push", "raw_delete"],
  }),
};

// ── session-profile agent contracts ───────────────────────────────────────
//
// Session profiles are operator-facing entry points (`prx plan session`,
// `prx implement`, etc.). Each one is also a 1→1 contract over its own
// artifact pair. Capabilities / forbidden are projected from the existing
// SessionProfileConfig (allowedTools / disallowedTools) so round-trip parity
// holds — see `projectSessionProfile` below for the inverse direction.

const sessionProfileIo: Record<SessionProfileName, { input: string; output: string }> = {
  plan: { input: "uow", output: "plan" },
  intake: { input: "external_signal", output: "uow" },
  triage: { input: "uow_queue", output: "triaged_queue" },
  implement: { input: "plan", output: "patch_proposal" },
  submit: { input: "patch_proposal", output: "pr_submission" },
  author: { input: "pr_submission", output: "pr_body" },
  // GH-2394: scratch is an ad-hoc, work-unit-UNBOUND least-privilege session
  // with no artifact pipeline — it neither consumes a planned artifact nor
  // produces one. The 1→1 contract is a self-edge over an ad-hoc session.
  scratch: { input: "scratch_session", output: "scratch_session" },
};

function buildSessionProfileContract(name: SessionProfileName): AgentContract {
  const profile = SESSION_PROFILES[name];
  const io = sessionProfileIo[name];
  return agentContractSchema.parse({
    role: name,
    inputArtifact: io.input,
    outputArtifact: io.output,
    capabilities: profile.allowedTools,
    forbidden: profile.disallowedTools,
  });
}

const sessionProfileContracts: Record<SessionProfileName, AgentContract> = {
  plan: buildSessionProfileContract("plan"),
  intake: buildSessionProfileContract("intake"),
  triage: buildSessionProfileContract("triage"),
  implement: buildSessionProfileContract("implement"),
  submit: buildSessionProfileContract("submit"),
  author: buildSessionProfileContract("author"),
  scratch: buildSessionProfileContract("scratch"),
};

// ── registry ──────────────────────────────────────────────────────────────

const allEntries: AgentContract[] = [
  ...taskAgentRoles.map((role) => taskRoleContracts[role]),
  ...sessionProfileNames.map((name) => sessionProfileContracts[name]),
];

export const agentRegistry: Readonly<Record<string, AgentContract>> = Object.freeze(
  Object.fromEntries(allEntries.map((entry) => [entry.role, entry])),
);

export function listAgentContracts(): readonly AgentContract[] {
  return allEntries;
}

export function getAgentContract(role: string): AgentContract | undefined {
  return agentRegistry[role];
}

export function getTaskRoleContract(role: TaskAgentRole): AgentContract {
  return taskRoleContracts[role];
}

export function getSessionProfileContract(name: SessionProfileName): AgentContract {
  return sessionProfileContracts[name];
}

// ── round-trip projection ─────────────────────────────────────────────────
//
// Inverse direction: given an AgentContract built from a SessionProfileConfig,
// project it back to the {allowedTools, disallowedTools, allowedDispatchTargets}
// triple. The test asserts these match the original SESSION_PROFILES entry.

export type SessionProfileProjection = {
  allowedTools: string[];
  disallowedTools: string[];
  allowedDispatchTargets: DispatchActor[];
};

export function projectSessionProfile(contract: AgentContract): SessionProfileProjection {
  const name = contract.role as SessionProfileName;
  if (!(sessionProfileNames as readonly string[]).includes(name)) {
    throw new Error(`not a session-profile contract: ${contract.role} (use projectTaskRole)`);
  }
  return {
    allowedTools: [...contract.capabilities],
    disallowedTools: [...contract.forbidden],
    allowedDispatchTargets: [...defaultDispatchCapabilities[name]],
  };
}

export type TaskRoleProjection = {
  role: TaskAgentRole;
  inputArtifact: string;
  outputArtifact: string;
  capabilities: string[];
  forbidden: string[];
};

export function projectTaskRole(contract: AgentContract): TaskRoleProjection {
  const role = contract.role as TaskAgentRole;
  if (!(taskAgentRoles as readonly string[]).includes(role)) {
    throw new Error(`not a task-role contract: ${contract.role} (use projectSessionProfile)`);
  }
  return {
    role,
    inputArtifact: contract.inputArtifact,
    outputArtifact: contract.outputArtifact,
    capabilities: [...contract.capabilities],
    forbidden: [...contract.forbidden],
  };
}
