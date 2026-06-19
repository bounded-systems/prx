import { processEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";
import { z } from "zod";

import type { RuntimeProfileProjection } from "../machine/runtime_profiles.ts";
import { resolveAgentBackend } from "../machine/runtime_profiles.ts";
import {
  runClaudeAgentNonInteractive,
  type ClaudeAgentServiceDeps,
  type NonInteractiveAgentResult,
  type RunClaudeAgentNonInteractiveOpts,
} from "../claude/agent_service.ts";

export const runtimeExecutionFormats = ["plain", "json"] as const;
export type RuntimeExecutionFormat = (typeof runtimeExecutionFormats)[number];

export type RuntimeExecutionResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type RuntimeExecutor = (
  profile: RuntimeProfileProjection,
  format: RuntimeExecutionFormat,
  cwd?: string,
  timeoutMs?: number,
) => RuntimeExecutionResult;

const adapterResultSchema = z
  .object({
    status: z.enum(["success", "error", "timeout"]),
    data: z.unknown().optional(),
    error: z.object({ message: z.string() }).optional(),
    meta: z.object({
      latency_ms: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type AdapterResult = z.infer<typeof adapterResultSchema>;

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseStrictJsonObject(
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "empty output" };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return { ok: true, value: parsed };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid json: ${details}` };
  }
}

export const localRuntimeExecutor: RuntimeExecutor = (
  profile,
  format,
  cwd = process.cwd(),
  timeoutMs,
) => {
  const env = {
    ...processEnv(),
    ...(profile.env ?? {}),
  };

  const run = (cmd: string[], stdio: "pipe" | "inherit"): RuntimeExecutionResult => {
    try {
      const result = defaultRunner(cmd, {
        cwd,
        env,
        stdio,
        check: false,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      // defaultRunner throws on a spawn error. A fired timeout surfaces as
      // ETIMEDOUT — map it to the conventional 124 so the dispatcher reads it
      // as a watchdog timeout; any other spawn failure is a generic error.
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ETIMEDOUT") {
        return { status: 124, stdout: "", stderr: "timed out" };
      }
      return { status: 1, stdout: "", stderr: err.message || String(error) };
    }
  };

  if (format === "plain") {
    const commandLine = [profile.command, ...profile.args].map(shellQuote).join(" ");
    const fallbackArgs = profile.fallbackArgs;
    const fallbackCommandLine = fallbackArgs
      ? [profile.command, ...fallbackArgs].map(shellQuote).join(" ")
      : "";
    const shellCommand = fallbackArgs
      ? `${commandLine} || { rc=$?; if [ "$rc" -eq 1 ]; then ${fallbackCommandLine}; exit $?; fi; exit "$rc"; }`
      : `exec ${commandLine}`;
    return run(["/bin/zsh", "-lc", shellCommand], "inherit");
  }

  return run([profile.command, ...profile.args], "pipe");
};

export function executeValidatedAgentOnce(
  profile: RuntimeProfileProjection,
  cwd: string,
  execRuntime: RuntimeExecutor,
): AdapterResult {
  const startedAt = Date.now();
  const execution = execRuntime(profile, "json", cwd);
  const latency = Date.now() - startedAt;
  if (execution.status !== 0) {
    const timeoutLike =
      /timed out|timeout/i.test(execution.stderr) || /timed out|timeout/i.test(execution.stdout);
    return {
      status: timeoutLike ? "timeout" : "error",
      error: {
        message:
          execution.stderr.trim() ||
          execution.stdout.trim() ||
          `runtime exited with status ${execution.status}`,
      },
      meta: {
        latency_ms: latency,
      },
    };
  }
  const parsed = parseStrictJsonObject(execution.stdout);
  if (!parsed.ok) {
    return {
      status: "error",
      error: {
        message: parsed.message,
      },
      meta: {
        latency_ms: latency,
      },
    };
  }
  const contract = adapterResultSchema.safeParse(parsed.value);
  if (!contract.success) {
    const issue = contract.error.issues[0];
    return {
      status: "error",
      error: {
        message: issue
          ? `schema validation failed at ${issue.path.join(".") || "<root>"}: ${issue.message}`
          : "schema validation failed",
      },
      meta: {
        latency_ms: latency,
      },
    };
  }
  return {
    ...contract.data,
    meta: {
      latency_ms: latency,
    },
  };
}

export function executeValidatedAgentWithRetry(
  profile: RuntimeProfileProjection,
  cwd: string,
  execRuntime: RuntimeExecutor,
  maxAttempts = 2,
): { result: AdapterResult; attempts: number } {
  let attempts = 0;
  let latest: AdapterResult = {
    status: "error",
    error: { message: "no attempts executed" },
    meta: { latency_ms: 0 },
  };
  while (attempts < maxAttempts) {
    attempts += 1;
    latest = executeValidatedAgentOnce(profile, cwd, execRuntime);
    if (latest.status === "success" || latest.status === "timeout") {
      break;
    }
  }
  const validated = adapterResultSchema.parse(latest);
  return {
    result: validated,
    attempts,
  };
}

// ── GH-1828: SDK-routed dispatcher ─────────────────────────────────────────

/**
 * GH-1828: typed result of dispatching a profile through either the legacy
 * subprocess executor (always `kind: "subprocess"`) or the SDK service.
 * Callers narrow on `kind` and then on the inner `result.kind` for the SDK
 * variant.
 */
export type AgentProfileExecutionResult =
  | {
      kind: "subprocess";
      execution: RuntimeExecutionResult;
    }
  | {
      kind: "sdk";
      result: NonInteractiveAgentResult;
    };

export type ExecuteAgentProfileOpts = {
  cwd: string;
  /** Execution format for the subprocess fallback. Defaults to `"json"`. */
  format?: RuntimeExecutionFormat;
  /**
   * Watchdog timeout. Honored by both routes:
   *   - subprocess: passed to `localRuntimeExecutor` as the @bounded-systems/proc timeout.
   *   - sdk: wired to the SDK `AbortController` per spike §3.2 (typed
   *     cancellation, distinguishable from network / model / rate-limit).
   * prx-hz1: the SDK path no longer treats `undefined` as "no watchdog" — a
   * headless autonomous run has no operator to unstick it, so an absent deadline
   * means a silent infinite hang. When the caller does not opt into a tighter
   * value, the SDK backend falls back to {@link DEFAULT_HEADLESS_AGENT_WATCHDOG_MS}.
   * Pass an explicit `timeoutMs` (or `sdkOpts.timeoutMs`) to override. The
   * subprocess route still honors `undefined` as "no proc timeout".
   */
  timeoutMs?: number;
  /** Operator cancellation (SIGINT handler, parent abort, …). SDK route only. */
  signal?: AbortSignal;
  sdkOpts?: Partial<RunClaudeAgentNonInteractiveOpts>;
  sdkDeps?: ClaudeAgentServiceDeps;
  /** Override for the subprocess executor (existing pre-1828 DI seam). */
  subprocessExecutor?: RuntimeExecutor;
};

/**
 * prx-hz1: anti-hang ceiling for headless SDK runs that didn't opt into a
 * tighter watchdog. NOT an SLA — a legitimate triage/intake/implement pass
 * completes well within it; this exists only to convert a silent infinite hang
 * (no operator to unstick a stalled stream / stray approval) into a typed
 * cancellation the caller can observe. Callers wanting a real budget pass an
 * explicit `timeoutMs`.
 */
export const DEFAULT_HEADLESS_AGENT_WATCHDOG_MS = 15 * 60_000;

/**
 * prx-who: the headless watchdog is now an IDLE ceiling (reset on every streamed
 * message), not a total-runtime cap — a productive run never trips it. This is a
 * generous idle window for the long-running executor: implement does real,
 * multi-file refactors that can pause to think between tool calls, and only true
 * silence (a stuck stream / stray approval) should ever cancel it.
 */
export const DEFAULT_IMPLEMENT_WATCHDOG_MS = 45 * 60_000;

/**
 * GH-1828 dispatcher. Routes profiles whose derived backend is `"sdk"`
 * (headless + claude — see `resolveAgentBackend`) to
 * `runClaudeAgentNonInteractive`; everything else (interactive sessions,
 * headless `--print` non-claude agents, profiles that omit the axis) flows
 * through the legacy `localRuntimeExecutor` unchanged. The backend is derived
 * from the headless-first `interaction` axis, which falls back to
 * `agentRuntime` when unset, so pre-axis behavior is preserved exactly.
 *
 * `subprocessExecutor` is a pre-1828 DI seam (`deps.execRuntime`). When set,
 * it takes precedence over the SDK route — tests that injected a fake
 * subprocess runner before GH-1828 keep working without changes, and any
 * call site that wants to force the subprocess path can do so without
 * mutating the profile.
 */
export async function executeAgentProfile(
  profile: RuntimeProfileProjection,
  opts: ExecuteAgentProfileOpts,
): Promise<AgentProfileExecutionResult> {
  const backend = resolveAgentBackend(profile);
  if (backend === "sdk" && !opts.subprocessExecutor) {
    const sdkOpts: RunClaudeAgentNonInteractiveOpts = {
      cwd: opts.cwd,
      // prx-hz1: never let a headless SDK run hang forever. Default to a
      // generous anti-hang ceiling when the caller didn't opt into a tighter
      // watchdog; an explicit `sdkOpts.timeoutMs` below still wins.
      timeoutMs: opts.timeoutMs ?? DEFAULT_HEADLESS_AGENT_WATCHDOG_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sdkOpts ?? {}),
    };
    const result = await runClaudeAgentNonInteractive(profile, sdkOpts, opts.sdkDeps ?? {});
    return { kind: "sdk", result };
  }
  const exec = opts.subprocessExecutor ?? localRuntimeExecutor;
  const execution = exec(profile, opts.format ?? "json", opts.cwd, opts.timeoutMs);
  return { kind: "subprocess", execution };
}

/**
 * GH-1828 — collapse an {@link AgentProfileExecutionResult} into the
 * pre-1828 `RuntimeExecutionResult` shape for callers that have not yet
 * been migrated to the typed SDK result union. Lets the SDK path land
 * incrementally: the triage classifier and probe sites can adopt
 * `executeAgentProfile` and continue to consume `{status, stdout, stderr}`
 * while the plan-print handler grows native handling of the union.
 *
 * Mapping:
 *   - `success`  → `{ status: 0,   stdout: envelope, stderr: "" }`
 *   - `cancelled` → `{ status: 124, stdout: partialStdout, stderr: "..." }`
 *   - `failed`   → `{ status: 1,   stdout: "", stderr: message }`
 */
export function agentProfileExecutionAsRuntimeResult(
  result: AgentProfileExecutionResult,
): RuntimeExecutionResult {
  if (result.kind === "subprocess") return result.execution;
  const sdk = result.result;
  if (sdk.kind === "success") {
    return { status: 0, stdout: sdk.stdout, stderr: "" };
  }
  if (sdk.kind === "cancelled") {
    const detail =
      sdk.configured_timeout_ms !== null
        ? `cancelled after ${sdk.elapsed_ms}ms (configured --timeout=${sdk.configured_timeout_ms}ms; reason=${sdk.reason})`
        : `cancelled after ${sdk.elapsed_ms}ms (reason=${sdk.reason})`;
    return { status: 124, stdout: sdk.partialStdout, stderr: detail };
  }
  return {
    status: 1,
    stdout: "",
    stderr: `[${sdk.errorKind}] ${sdk.message}`,
  };
}
