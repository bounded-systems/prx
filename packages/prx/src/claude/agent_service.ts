// GH-1828 — Non-interactive Claude agent runtime.
//
// One-shot caller surface for the Anthropic Agent SDK. Wraps
// `@anthropic-ai/claude-agent-sdk`'s `query()` with the §3.2 contract from
// docs/spikes/GH-1827-actor-session-modes.md: typed cancellation, partial
// capture, typed errors, usage telemetry.
//
// Interactive callers (`prx plan session --interactive`, `prx session open`,
// `prx implement`) stay on the CLI subprocess (`localRuntimeExecutor`) per
// the ADR's §5 step 7.

import { bakedClaudeCodePath } from "../build-info.ts";
import { getEnv, processEnv } from "@bounded-systems/env";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  createSdkMcpServer,
  tool,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  appendAuditRow,
  type AuditSinkDeps,
} from "../audit/sink.ts";
import {
  PlanArtifactShape,
  renderPlanArtifact,
  type PlanArtifact,
} from "../plan-store/plan-artifact.ts";
import type {
  RuntimeAgentSdkSpec,
  RuntimeProfileProjection,
} from "../machine/runtime_profiles.ts";

// ── public contract ────────────────────────────────────────────────────────

export const usageTelemetrySchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
});
export type UsageTelemetry = z.infer<typeof usageTelemetrySchema>;

export const nonInteractiveSuccessSchema = z.object({
  kind: z.literal("success"),
  /**
   * Raw assistant text — the model's reply as a plain string. Use this for
   * callers that wanted the plan body, not a JSON envelope (plan-print).
   */
  text: z.string(),
  /**
   * JSON envelope wrapping `text` in the `claude --print --output-format json`
   * shape that `parseClaudeJsonEnvelope` / `parseHaikuEnvelope` already
   * consume. Lets the triage Haiku classifier and other envelope-parsing
   * callers migrate without changing their parser.
   */
  stdout: z.string(),
  envelope: z.unknown().optional(),
  usage: usageTelemetrySchema,
  totalCostUsd: z.number().nonnegative().optional(),
  elapsed_ms: z.number().int().nonnegative(),
});
export type NonInteractiveSuccess = z.infer<typeof nonInteractiveSuccessSchema>;

export const nonInteractiveCancelledSchema = z.object({
  kind: z.literal("cancelled"),
  reason: z.enum(["watchdog", "operator"]),
  elapsed_ms: z.number().int().nonnegative(),
  configured_timeout_ms: z.number().int().nonnegative().nullable(),
  draftRef: z.string().nullable(),
  partialStdout: z.string(),
});
export type NonInteractiveCancelled = z.infer<typeof nonInteractiveCancelledSchema>;

export const nonInteractiveFailedSchema = z.object({
  kind: z.literal("failed"),
  errorKind: z.enum(["rate_limit", "network", "model", "cancelled"]),
  message: z.string(),
  retryAfter: z.number().int().nonnegative().optional(),
  elapsed_ms: z.number().int().nonnegative(),
});
export type NonInteractiveFailed = z.infer<typeof nonInteractiveFailedSchema>;

export const nonInteractiveAgentResultSchema = z.discriminatedUnion("kind", [
  nonInteractiveSuccessSchema,
  nonInteractiveCancelledSchema,
  nonInteractiveFailedSchema,
]);
export type NonInteractiveAgentResult = z.infer<typeof nonInteractiveAgentResultSchema>;

// ── streaming events surface ───────────────────────────────────────────────

/**
 * In-process event channel for callers that want to render token-level output
 * (e.g. `prx plan session --print` relaying assistant deltas to stdout). The
 * subset shipped here matches what GH-1828's call sites actually consume; the
 * full SDK message stream is intentionally not re-exported so consumers do
 * not couple to SDK internals.
 */
export type NonInteractiveStreamEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "partial_assistant_text"; text: string }
  | { kind: "result"; result: SDKResultMessage };

export type DraftSink = (partialStdout: string) => Promise<string | null>;

export type RunClaudeAgentNonInteractiveOpts = {
  cwd: string;
  /**
   * Opt-in watchdog. When omitted the run has no internal timeout — operator
   * cancellation via `signal` is still honored. Per spike §3.2: "no
   * baked-in default for spikes of arbitrary size like GH-1823".
   */
  timeoutMs?: number;
  /** Operator-side cancellation (SIGINT handler, parent process abort, …). */
  signal?: AbortSignal;
  onStreamEvent?: (event: NonInteractiveStreamEvent) => void;
  /**
   * Persist accumulated stdout when a run is cancelled (watchdog or operator).
   * Returns the saved ref (`<UoW>:plan@draft` shape) or null when the caller
   * doesn't want a draft.
   */
  draftSink?: DraftSink;
  /** GH-1828 — work-unit-id stamp on audit-sink rows. */
  workUnitId?: string;
  /** GH-1828 — disable the audit-sink chain (tests). */
  disableAudit?: boolean;
  /** GH-1828 — DI seam for the audit sink (tests). */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1407 — debug knob that invalidates the Anthropic prompt cache for a
   * single run by prepending a random nonce to the stable systemPrompt
   * prefix. Use this to compare cold-path latency / token cost against the
   * warm path (`prx services status --anthropic`) when validating that the
   * cache split actually buys what it claims. The SDK does not expose a
   * native cache-bypass switch, so the nonce is the contract.
   */
  noCache?: boolean;
};

// ── DI seam ────────────────────────────────────────────────────────────────

/**
 * Indirection for the underlying SDK `query` so tests can inject a fake
 * adapter that emits synthetic SDKMessages. The real implementation maps to
 * `@anthropic-ai/claude-agent-sdk`'s `query()` 1:1.
 */
export type ClaudeAgentQuery = (params: {
  prompt: string;
  options?: Options;
}) => Query;

export type ClaudeAgentServiceDeps = {
  query?: ClaudeAgentQuery;
  /** Override the clock for elapsed_ms (tests). */
  now?: () => number;
};

const defaultDeps: Required<Pick<ClaudeAgentServiceDeps, "now">> = {
  now: () => Date.now(),
};

let cachedQuery: ClaudeAgentQuery | null = null;
async function loadDefaultQuery(): Promise<ClaudeAgentQuery> {
  if (cachedQuery) return cachedQuery;
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  cachedQuery = mod.query;
  return cachedQuery;
}

// ── GH-2337 — submit_plan plan-artifact capture seam ────────────────────────

/** In-process SDK MCP server name; the tool resolves to `mcp__<name>__<tool>`. */
const PLAN_CAPTURE_SERVER_NAME = "prx-plan";
const SUBMIT_PLAN_TOOL_NAME = "submit_plan";
const SUBMIT_PLAN_ALLOWED_TOOL = `mcp__${PLAN_CAPTURE_SERVER_NAME}__${SUBMIT_PLAN_TOOL_NAME}`;
const SUBMIT_PLAN_DESC =
  "Submit the implementation plan as a structured artifact. Required to complete planning.";

type PlanCaptureServerEntry = NonNullable<Options["mcpServers"]>[string];

/**
 * The `Options.mcpServers` entry the capture seam injects, plus a direct
 * reference to the validated `submit_plan` handler. The SDK reads only
 * `type`/`name`/`instance` off the entry; the extra `handler` field is inert
 * in production and exists so the in-process test seam can invoke submit_plan
 * without driving a live MCP transport.
 */
type PlanCaptureMcpServer = PlanCaptureServerEntry & {
  handler: (args: PlanArtifact, extra: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
};

/**
 * Build the `prx-plan` in-process MCP server. The `submit_plan` tool's input
 * schema *is* {@link PlanArtifactShape}, so the SDK Zod-validates the model's
 * tool input before the handler runs — the enforcement point. The handler
 * stashes the validated artifact into a closure readable via `getCaptured`.
 */
function buildPlanCaptureServer(): {
  mcpServer: PlanCaptureMcpServer;
  getCaptured: () => PlanArtifact | null;
} {
  let captured: PlanArtifact | null = null;
  const submitPlanTool = tool(
    SUBMIT_PLAN_TOOL_NAME,
    SUBMIT_PLAN_DESC,
    PlanArtifactShape,
    async (args) => {
      // SDK Zod-validated against PlanArtifactShape before this runs.
      captured = args;
      return { content: [{ type: "text", text: "Plan captured." }] };
    },
  );
  const base = createSdkMcpServer({
    name: PLAN_CAPTURE_SERVER_NAME,
    tools: [submitPlanTool],
  });
  const mcpServer = Object.assign(base, {
    handler: submitPlanTool.handler,
  }) as PlanCaptureMcpServer;
  return { mcpServer, getCaptured: () => captured };
}

// ── profile → SDK options translation ──────────────────────────────────────

/**
 * Resolve the native `claude` executable for the SDK's
 * `pathToClaudeCodeExecutable` (prx-5el / GH-2137). A `bun build --compile`
 * artifact carries no adjacent `node_modules`, so the SDK cannot self-resolve
 * its native CLI; we point it at an already-installed `claude`.
 *
 * Picks the first candidate that EXISTS — not the first truthy. The release
 * binary bakes the CI runner's `$HOME/.local/bin/claude` into
 * `bakedClaudeCodePath()`, which is truthy but absent on the operator's machine;
 * a plain `??` chain stops at that dead path and leaves the field unset, so the
 * SDK throws "Native CLI binary … not found". Trying by existence falls through
 * the dead baked path to the real `~/.local/bin/claude`.
 *
 * Precedence: `PRX_CLAUDE_CODE_PATH` → baked compile-time path → `$HOME` default.
 */
export function resolveClaudeExecutablePath(
  candidates: ReadonlyArray<string | undefined> = [
    getEnv("PRX_CLAUDE_CODE_PATH"),
    bakedClaudeCodePath(),
    join(homedir(), ".local/bin/claude"),
  ],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return candidates.find(
    (p): p is string => typeof p === "string" && p.length > 0 && exists(p),
  );
}

/**
 * prx-pe1 (slice 3): resolve the directory containing `bun` so the headless
 * executor's allowlisted `bun test` / `bun run typecheck` checks actually
 * resolve. bun is routinely absent from the non-interactive PATH the SDK
 * subprocess inherits (memory: bun-not-on-noninteractive-path), so a check the
 * allowlist permits still fails "command not found" — which is what made a real
 * executor refuse to commit. Picks the first dir that actually holds a `bun`
 * executable. Precedence: `PRX_BUN_DIR` → common `$HOME` installs.
 */
export function resolveBunDir(
  candidates: ReadonlyArray<string | undefined> = [
    getEnv("PRX_BUN_DIR"),
    join(homedir(), ".local/share/bun-home/bin"),
    join(homedir(), ".bun/bin"),
  ],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return candidates.find(
    (d): d is string => typeof d === "string" && d.length > 0 && exists(join(d, "bun")),
  );
}

function buildSdkOptions(
  spec: RuntimeAgentSdkSpec,
  opts: RunClaudeAgentNonInteractiveOpts,
  abortController: AbortController,
  planCapture: { mcpServer: PlanCaptureMcpServer } | null,
): Options {
  const options: Options = {
    abortController,
    cwd: opts.cwd,
  };

  // GH-2137 — a `bun build --compile` artifact carries no adjacent
  // `node_modules/`, so the SDK's `createRequire(import.meta.url).resolve(...)`
  // cannot locate its native `claude` CLI (resolution points into bun's
  // embedded virtual FS). Point the SDK at the already-installed native CLI.
  // 3-tier source mirrors the PRX_AI_HOME_ROOT/BAKED_AI_HOME_ROOT precedent
  // (src/pr-state/github.ts:3712): PRX override -> baked compile-time path ->
  // $HOME default. The existsSync guard means dev/CI runs (where the path is
  // absent and node_modules resolves) leave the field unset for SDK
  // self-resolution — safe everywhere.
  const claudePath = resolveClaudeExecutablePath();
  if (claudePath) {
    options.pathToClaudeCodeExecutable = claudePath;
  }

  if (spec.model !== undefined) options.model = spec.model;
  if (spec.permissionMode !== undefined) options.permissionMode = spec.permissionMode;
  if (spec.allowedTools !== undefined) options.allowedTools = spec.allowedTools;
  if (spec.disallowedTools !== undefined) options.disallowedTools = spec.disallowedTools;
  if (spec.tools !== undefined) options.tools = spec.tools;
  if (spec.mcpServers !== undefined) {
    options.mcpServers = spec.mcpServers as NonNullable<Options["mcpServers"]>;
  }
  if (spec.strictMcpConfig !== undefined) options.strictMcpConfig = spec.strictMcpConfig;
  if (spec.settingSources !== undefined) options.settingSources = spec.settingSources;
  if (spec.includePartialMessages) options.includePartialMessages = true;
  if (spec.maxTurns !== undefined) options.maxTurns = spec.maxTurns;

  // GH-2337 — inject the live `prx-plan` capture server at the IO boundary
  // (the pure projection only declares the capability flag). Merge into any
  // spec-declared mcpServers and append — not clobber — the allowedTools list.
  if (planCapture) {
    options.mcpServers = {
      ...(options.mcpServers ?? {}),
      [PLAN_CAPTURE_SERVER_NAME]: planCapture.mcpServer,
    };
    options.allowedTools = [...(options.allowedTools ?? []), SUBMIT_PLAN_ALLOWED_TOOL];
  }

  // GH-1407 — split-prompt shape (Options.systemPrompt = string[]) lets the
  // Anthropic prompt cache key on a byte-identical stable prefix even when
  // the dynamic suffix (workUnitId, per-batch user data) varies. Profiles
  // that set neither leave systemPrompt absent, which delegates to the
  // SDK's default (preset claude_code, internal/opaque caching).
  const stable = spec.systemPromptStable ?? [];
  const dynamic = spec.systemPromptDynamic ?? [];
  if (stable.length > 0 || dynamic.length > 0) {
    const stableWithNonce = opts.noCache
      // The SDK does not expose a cache-bypass switch, so we invalidate the
      // prefix by prepending a per-run UUID. The downstream stable content
      // still appears after the nonce so the prompt's semantics are
      // unchanged — only its cache key is.
      ? [`cache-nonce: ${randomUUID()}`, ...stable]
      : stable;
    options.systemPrompt = [
      ...stableWithNonce,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamic,
    ];
  }

  // prx-pe1 (slice 3): the SDK's tool subprocesses inherit `options.env`
  // (defaulting to the ambient environment). When bun is resolvable but missing
  // from the inherited PATH, prepend its dir so the executor's allowlisted
  // `bun test` / `bun run typecheck` checks resolve. Left unset (→ inherited
  // environment) when bun is already on PATH or not found, so non-executor
  // agents are unaffected.
  const bunDir = resolveBunDir();
  if (bunDir) {
    const env = processEnv();
    const currentPath = env.PATH ?? "";
    if (!currentPath.split(":").includes(bunDir)) {
      options.env = { ...env, PATH: currentPath ? `${bunDir}:${currentPath}` : bunDir };
    }
  }

  return options;
}

// ── result classification ──────────────────────────────────────────────────

function usageFromSdk(usage: SDKResultMessage["usage"] | undefined): UsageTelemetry {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Wrap the SDK `SDKResultSuccess.result` text in a single-event envelope that
 * matches the `claude --print --output-format json` shape consumed by
 * `parseClaudeJsonEnvelope` (`src/claude/envelope.ts`). Lets the legacy
 * envelope-parsing callers (triage Haiku classifier, plan-print) keep their
 * parser unchanged while flowing through the SDK transport.
 */
function envelopeStdout(result: string, totalCostUsd: number | undefined): string {
  const envelope: Record<string, unknown> = {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
  };
  if (typeof totalCostUsd === "number") {
    envelope.total_cost_usd = totalCostUsd;
  }
  return JSON.stringify(envelope);
}

function classifyAssistantError(
  error: string | undefined,
  message: string,
): NonInteractiveFailed["errorKind"] {
  if (error === "rate_limit") return "rate_limit";
  if (error === "server_error" || error === "unknown") return "network";
  if (error === "billing_error" || error === "max_output_tokens") return "model";
  if (error === "authentication_failed" || error === "oauth_org_not_allowed" || error === "invalid_request") return "model";
  const text = message.toLowerCase();
  if (/\b429\b|rate.?limit/.test(text)) return "rate_limit";
  if (/\bnetwork|econn|enotfound|timed? ?out|dns|tls/.test(text)) return "network";
  return "model";
}

// ── main entry point ───────────────────────────────────────────────────────

export async function runClaudeAgentNonInteractive(
  profile: RuntimeProfileProjection,
  opts: RunClaudeAgentNonInteractiveOpts,
  deps: ClaudeAgentServiceDeps = {},
): Promise<NonInteractiveAgentResult> {
  if (profile.agentRuntime !== "sdk" || !profile.sdkSpec) {
    throw new Error(
      `runClaudeAgentNonInteractive: profile is not SDK-routed (agentRuntime=${profile.agentRuntime ?? "subprocess"})`,
    );
  }
  const spec = profile.sdkSpec;
  const now = deps.now ?? defaultDeps.now;
  const queryFn = deps.query ?? (await loadDefaultQuery());

  // GH-2337 — when the profile opts in, build the in-process capture server so
  // the validated `submit_plan` artifact (rendered) becomes the success body.
  const planCapture = spec.capturePlanArtifact ? buildPlanCaptureServer() : null;

  const auditEnabled = !opts.disableAudit;
  const auditSink = opts.auditSink;
  const workUnitId = opts.workUnitId;
  const actorLabel = "claude-code";
  const profileLabel = `${profile.profile}/${profile.command}`;
  const emit = (row: Record<string, unknown>): void => {
    if (!auditEnabled) return;
    try {
      appendAuditRow(row, auditSink);
    } catch {
      // sink-side errors are intentionally swallowed; the SDK call already
      // carries the operator-visible signal via its typed result.
    }
  };

  const startedAt = now();
  const abortController = new AbortController();
  emit({
    ts: new Date(startedAt).toISOString(),
    kind: "non-interactive-agent",
    subkind: "started",
    profile: profileLabel,
    actor: actorLabel,
    ...(workUnitId ? { workUnitId } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(profile.env?.PRX_AGENT_ROLE ? { role: profile.env.PRX_AGENT_ROLE } : {}),
    ...(opts.noCache ? { cache_disabled: true } : {}),
  });

  let cancelled = false;
  let cancelReason: NonInteractiveCancelled["reason"] = "operator";
  const onWatchdog = () => {
    cancelled = true;
    cancelReason = "watchdog";
    abortController.abort();
  };
  const onOperator = () => {
    cancelled = true;
    cancelReason = "operator";
    abortController.abort();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) {
    timer = setTimeout(onWatchdog, opts.timeoutMs);
  }
  if (opts.signal) {
    if (opts.signal.aborted) onOperator();
    else opts.signal.addEventListener("abort", onOperator, { once: true });
  }

  let accumulatedText = "";
  let resultMessage: SDKResultMessage | null = null;
  let assistantError: NonInteractiveFailed | null = null;
  const elapsed = () => now() - startedAt;

  const iterator = queryFn({
    prompt: spec.prompt,
    options: buildSdkOptions(spec, opts, abortController, planCapture),
  });

  try {
    for await (const message of iterator as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant") {
        const content = message.message?.content ?? [];
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === "text" && typeof block.text === "string") {
            accumulatedText += block.text;
            opts.onStreamEvent?.({ kind: "assistant_text", text: block.text });
          }
        }
        if (message.error) {
          const errMsg = `assistant message marked error: ${message.error}`;
          assistantError = {
            kind: "failed",
            errorKind: classifyAssistantError(message.error, errMsg),
            message: errMsg,
            elapsed_ms: elapsed(),
          };
        }
      } else if (message.type === "stream_event") {
        // SDKPartialAssistantMessage — only emitted when `includePartialMessages: true`.
        const event = (message as { event?: { delta?: { text?: string } } }).event;
        const delta = event?.delta?.text;
        if (typeof delta === "string" && delta.length > 0) {
          opts.onStreamEvent?.({ kind: "partial_assistant_text", text: delta });
        }
      } else if (message.type === "result") {
        resultMessage = message;
        opts.onStreamEvent?.({ kind: "result", result: message });
        break;
      }
    }
  } catch (error) {
    if (cancelled) {
      // AbortController triggered the throw — fall through to the cancelled branch below.
    } else {
      const message = error instanceof Error ? error.message : String(error);
      const errorKind = classifyAssistantError(undefined, message);
      return {
        kind: "failed",
        errorKind,
        message,
        elapsed_ms: elapsed(),
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onOperator);
  }

  if (cancelled) {
    let draftRef: string | null = null;
    if (opts.draftSink && accumulatedText.length > 0) {
      try {
        draftRef = await opts.draftSink(accumulatedText);
      } catch {
        draftRef = null;
      }
    }
    const elapsedMs = elapsed();
    emit({
      ts: new Date(now()).toISOString(),
      kind: "non-interactive-agent",
      subkind: "cancelled",
      reason: cancelReason,
      elapsed_ms: elapsedMs,
      configured_timeout_ms: typeof opts.timeoutMs === "number" ? opts.timeoutMs : null,
      draft_ref: draftRef,
      actor: actorLabel,
      ...(workUnitId ? { workUnitId } : {}),
    });
    return {
      kind: "cancelled",
      reason: cancelReason,
      elapsed_ms: elapsedMs,
      configured_timeout_ms: typeof opts.timeoutMs === "number" ? opts.timeoutMs : null,
      draftRef,
      partialStdout: accumulatedText,
    };
  }

  if (assistantError) {
    const failure = { ...assistantError, elapsed_ms: elapsed() };
    emit({
      ts: new Date(now()).toISOString(),
      kind: "non-interactive-agent",
      subkind: "failed",
      error_kind: failure.errorKind,
      elapsed_ms: failure.elapsed_ms,
      message: failure.message,
      actor: actorLabel,
      ...(workUnitId ? { workUnitId } : {}),
    });
    return failure;
  }

  if (!resultMessage) {
    const failure: NonInteractiveFailed = {
      kind: "failed",
      errorKind: "model",
      message: "SDK query exited without emitting a terminal result message",
      elapsed_ms: elapsed(),
    };
    emit({
      ts: new Date(now()).toISOString(),
      kind: "non-interactive-agent",
      subkind: "failed",
      error_kind: failure.errorKind,
      elapsed_ms: failure.elapsed_ms,
      message: failure.message,
      actor: actorLabel,
      ...(workUnitId ? { workUnitId } : {}),
    });
    return failure;
  }

  if (resultMessage.subtype !== "success") {
    const errors = (resultMessage as { errors?: string[] }).errors ?? [];
    const message = errors.length > 0 ? errors.join("; ") : `SDK result subtype=${resultMessage.subtype}`;
    const failure: NonInteractiveFailed = {
      kind: "failed",
      errorKind: classifyAssistantError(undefined, message),
      message,
      elapsed_ms: elapsed(),
    };
    emit({
      ts: new Date(now()).toISOString(),
      kind: "non-interactive-agent",
      subkind: "failed",
      error_kind: failure.errorKind,
      elapsed_ms: failure.elapsed_ms,
      message: failure.message,
      actor: actorLabel,
      ...(workUnitId ? { workUnitId } : {}),
    });
    return failure;
  }

  const totalCostUsd = resultMessage.total_cost_usd;
  let text = resultMessage.result;
  // GH-2337 — when capturing, prefer the validated artifact (rendered to
  // canonical markdown) over the model's free-text reply. A successful run
  // that never called submit_plan is a planner contract violation → typed
  // `failed` (reusing errorKind "model"; no new result variant).
  if (planCapture) {
    const captured = planCapture.getCaptured();
    if (!captured) {
      const failure: NonInteractiveFailed = {
        kind: "failed",
        errorKind: "model",
        message: "planner did not call submit_plan",
        elapsed_ms: elapsed(),
      };
      emit({
        ts: new Date(now()).toISOString(),
        kind: "non-interactive-agent",
        subkind: "failed",
        error_kind: failure.errorKind,
        elapsed_ms: failure.elapsed_ms,
        message: failure.message,
        actor: actorLabel,
        ...(workUnitId ? { workUnitId } : {}),
      });
      return failure;
    }
    text = renderPlanArtifact(captured);
  }
  const stdout = envelopeStdout(text, totalCostUsd);
  const usage = usageFromSdk(resultMessage.usage);
  const elapsedMs = elapsed();
  const completionTs = new Date(now()).toISOString();
  emit({
    ts: completionTs,
    kind: "non-interactive-agent",
    subkind: "usage",
    profile: profileLabel,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    latency_ms: elapsedMs,
    actor: actorLabel,
    ...(workUnitId ? { workUnitId } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(typeof totalCostUsd === "number" ? { total_cost_usd: totalCostUsd } : {}),
    ...(opts.noCache ? { cache_disabled: true } : {}),
  });
  emit({
    ts: completionTs,
    kind: "non-interactive-agent",
    subkind: "completed",
    status: "success",
    output_hash: createHash("sha256").update(text).digest("hex"),
    elapsed_ms: elapsedMs,
    actor: actorLabel,
    ...(workUnitId ? { workUnitId } : {}),
  });
  return {
    kind: "success",
    text,
    stdout,
    envelope: resultMessage,
    usage,
    ...(typeof totalCostUsd === "number" ? { totalCostUsd } : {}),
    elapsed_ms: elapsedMs,
  };
}
