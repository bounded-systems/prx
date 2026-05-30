// ai-home-wlw5l — the `command` Stop-hook body + its per-session settings shape.
//
// `runTransitionGateHook` is the deterministic body a Claude Code `command` Stop
// hook runs: resolve the role + work unit + slot from the session env, read the
// run's single transition-artifact slot, run the validate-then-pin decision
// (`evaluateTransitionGate`), and map to the Stop-hook exit contract — exit 0
// (allow: the typed artifact is pinned to CAS, the run may finish) or exit 2
// with a stderr reason (block: termination refused, reason fed back to the run).
//
// `buildTransitionGateStopSettings` is the per-session `--settings` JSON that
// registers the hook. It MUST be written to a per-session settings file passed
// via `--settings` (the scratch-sandbox precedent, runtime_profiles.ts), NOT the
// shared project `.claude/settings.json` — a project Stop hook has no matcher
// and would block every session in the repo. Wiring it into the profile launch
// path is the deferred slice (it needs a real launch to verify).
//
// I/O (env, slot read) is injected so the body is unit-testable; the thin
// `.claude/hooks/transition-gate.ts` script supplies the real process env + fs.

import { join } from "node:path";

import {
  evaluateTransitionGate,
  type TransitionGateInput,
} from "./transition-gate.ts";
import type { PinTransitionDeps } from "./transition-artifact.ts";

/** Slot path relative to the session cwd, beside the other runtime files. */
export const DEFAULT_TRANSITION_SLOT = ".pr/local/runtime/transition.json";

/**
 * The documented Claude Code Stop-hook stdin envelope — the boundary contract.
 * We parse it (rather than relying only on env) so the gate is driven by what
 * Claude Code actually sends, and so the whole boundary is testable by mocking
 * the envelope (no live launch needed). Only the fields the gate uses are typed.
 */
export interface StopHookEnvelope {
  hook_event_name?: string;
  session_id?: string;
  /** Session working directory — the slot resolves relative to this. */
  cwd?: string;
  /** True when Claude is already continuing from a prior Stop block. */
  stop_hook_active?: boolean;
}

/** Parse the Stop-hook stdin envelope; tolerant of empty/malformed input. */
export function parseStopEnvelope(stdin: string): StopHookEnvelope {
  if (typeof stdin !== "string" || stdin.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(stdin);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StopHookEnvelope)
      : {};
  } catch {
    return {};
  }
}

export interface TransitionHookEnv {
  /** The agent role (planner/executor/triage/intake/submit/author/…). */
  PRX_AGENT_ROLE?: string | undefined;
  PRX_PLAN_SESSION_UNIT?: string | undefined;
  PRX_SUBMIT_SESSION_UNIT?: string | undefined;
  PRX_WORK_UNIT?: string | undefined;
  /** Override the slot path; defaults to {@link DEFAULT_TRANSITION_SLOT}. */
  PRX_TRANSITION_SLOT?: string | undefined;
}

export interface TransitionHookDeps {
  /** Raw Stop-hook stdin envelope (the boundary contract). */
  stdin: string;
  env: TransitionHookEnv;
  /** Reads the slot file; returns null when it does not exist. */
  readSlot: (path: string) => string | null;
  /** Injected CAS deps for the pin (testing); defaults to the real plan-store. */
  pinDeps?: PinTransitionDeps;
}

export interface TransitionHookResult {
  /** 0 = allow stop; 2 = block stop (Stop-hook exit-2 contract). */
  exitCode: 0 | 2;
  /** On allow: the pinned CAS handle. On block: the reason (→ stderr). */
  message: string;
}

function resolveWorkUnit(env: TransitionHookEnv): string {
  return (
    env.PRX_PLAN_SESSION_UNIT ??
    env.PRX_SUBMIT_SESSION_UNIT ??
    env.PRX_WORK_UNIT ??
    "session"
  );
}

/**
 * Run the exit gate. Parses the Stop-hook stdin envelope (the boundary
 * contract) for the session cwd, resolves role/unit from env + the slot
 * relative to that cwd, reads the slot (missing ⇒ empty ⇒ block), and maps the
 * gate decision to the Stop-hook exit contract. Pure over its injected deps —
 * mock the envelope to test the whole boundary without a live launch.
 */
export async function runTransitionGateHook(
  deps: TransitionHookDeps,
): Promise<TransitionHookResult> {
  const envelope = parseStopEnvelope(deps.stdin);
  const role = deps.env.PRX_AGENT_ROLE ?? "unknown";
  // The slot resolves relative to the session cwd Claude Code reports in the
  // envelope (the hook also runs in that cwd, but the envelope is authoritative).
  const slotPath =
    deps.env.PRX_TRANSITION_SLOT ??
    join(envelope.cwd ?? ".", DEFAULT_TRANSITION_SLOT);
  const raw = deps.readSlot(slotPath) ?? "";

  const input: TransitionGateInput = {
    raw,
    role,
    workUnitId: resolveWorkUnit(deps.env),
    ...(deps.pinDeps !== undefined ? { deps: deps.pinDeps } : {}),
  };
  const decision = await evaluateTransitionGate(input);
  return decision.decision === "allow"
    ? { exitCode: 0, message: decision.handle }
    : { exitCode: 2, message: decision.reason };
}

export interface StopHookSettings {
  hooks: {
    Stop: Array<{ hooks: Array<{ type: "command"; command: string }> }>;
  };
}

/**
 * Per-session settings registering the transition gate as a `command` Stop hook.
 * Written to a per-session file passed via `--settings` (NOT shared project
 * settings). `hookCommand` is the shell command that runs the hook script, e.g.
 * `bun ${CLAUDE_PROJECT_DIR}/.claude/hooks/transition-gate.ts`.
 */
export function buildTransitionGateStopSettings(
  hookCommand: string,
): StopHookSettings {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: hookCommand }] }],
    },
  };
}
