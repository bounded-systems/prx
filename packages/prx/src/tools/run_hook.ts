/**
 * run-hook — per-repo wt hook dispatcher (GH-888, intern-wtctl PR-2).
 *
 * Worktrunk runs hook commands at lifecycle points (pre-start, post-switch,
 * post-start, …). PR #887 (GH-880) interned the first hook by hardcoding
 * `prx tools wt ensure-prx-excludes` in the global worktrunk config, which
 * means every repo gets the same behavior and per-repo customization
 * requires editing `~/.config/worktrunk/`.
 *
 * This dispatcher inverts that: worktrunk calls one uniform command —
 * `prx tools wt run-hook <event>` — and prx resolves the active repo,
 * prefers a per-repo override at
 *   `<aiHomeRoot>/.prx/repos/io.github/<owner>/<repo>/hooks/<event>`,
 * and falls back to a built-in registry. Per-repo overrides ship in
 * ai-home alongside the existing `prx.toml` overlays.
 *
 * Hook contract: best-effort. Always exit 0 even on missing repo,
 * unknown event, or override failure — a wt-hook must not turn into a
 * `wt switch` failure.
 */
import { bakedAiHomeRoot } from "../build-info.ts";
import { getEnv } from "@bounded-systems/env";
import { existsSync, statSync, constants as fsConstants, accessSync } from "node:fs";
import { join } from "node:path";

import { defaultRunner as procDefaultRunner } from "@bounded-systems/proc";

import {
  type CommandRunner,
  defaultRunner,
  parseGithubRepo,
  reverseDnsRepoSegments,
} from "../pr-state/github.ts";
import { ensurePrxExcludes } from "./ignore_sync.ts";
import { ensureClaudeSettings } from "./ensure_claude_settings.ts";
import { loadWorkspaceConfig } from "../pr-state/github.ts";

export type RunHookSource = "builtin" | "override" | "skipped";

export type RunHookSkipReason =
  | "no-repo"
  | "unknown-event"
  | "override-not-executable";

export type RunHookResult = {
  event: string;
  source: RunHookSource;
  reason?: RunHookSkipReason | undefined;
  /** Resolved override path, when one was found and considered. */
  overridePath?: string | undefined;
  /** Repo root resolved from cwd, when in a git repo. */
  repoRoot?: string | undefined;
  /** Exit code from the hook execution. Always 0 from the CLI dispatcher. */
  exitCode: number;
  /** Builtin-only: details from the underlying tool, when it produces structured output. */
  builtin?: { name: string; details?: unknown } | undefined;
};

export type RunHookOptions = {
  event: string;
  cwd: string;
  runner?: CommandRunner;
  /** Override the env-derived ai-home root (tests). */
  aiHomeRoot?: string | null;
  /** Override origin URL lookup (tests). When set, skips `git remote get-url`. */
  originUrl?: string;
};

type BuiltinHandler = (ctx: {
  repoRoot: string;
  runner: CommandRunner;
  aiHomeRoot: string | null;
}) => RunHookResult;

const BUILTINS: Record<string, BuiltinHandler> = {
  "ensure-prx-excludes": runEnsurePrxExcludes,
  "ensure-claude-settings": runEnsureClaudeSettings,
};

export function isBuiltinHookEvent(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTINS, event);
}

export function runHook(opts: RunHookOptions): RunHookResult {
  const runner = opts.runner ?? defaultRunner;
  const event = opts.event;

  const repoRoot = resolveRepoRoot(opts.cwd, runner);
  if (!repoRoot) {
    return {
      event,
      source: "skipped",
      reason: "no-repo",
      exitCode: 0,
    };
  }

  const aiHomeRoot =
    opts.aiHomeRoot !== undefined
      ? opts.aiHomeRoot
      : getEnv("PRX_AI_HOME_ROOT") ?? bakedAiHomeRoot() ?? null;

  const overridePath = resolveOverridePath({
    repoRoot,
    runner,
    aiHomeRoot,
    event,
    originUrl: opts.originUrl,
  });

  if (overridePath && existsSync(overridePath)) {
    if (!isExecutable(overridePath)) {
      return {
        event,
        source: "skipped",
        reason: "override-not-executable",
        overridePath,
        repoRoot,
        exitCode: 0,
      };
    }
    const result = procDefaultRunner([overridePath], {
      cwd: repoRoot,
      stdio: "inherit",
      check: false,
    });
    return {
      event,
      source: "override",
      overridePath,
      repoRoot,
      exitCode: result.status,
    };
  }

  const builtin = BUILTINS[event];
  if (!builtin) {
    return {
      event,
      source: "skipped",
      reason: "unknown-event",
      overridePath: overridePath ?? undefined,
      repoRoot,
      exitCode: 0,
    };
  }

  return builtin({ repoRoot, runner, aiHomeRoot });
}

function resolveRepoRoot(cwd: string, runner: CommandRunner): string | null {
  try {
    const result = runner(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      check: false,
    });
    if (result.status !== 0) return null;
    const out = (result.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function resolveOverridePath(args: {
  repoRoot: string;
  runner: CommandRunner;
  aiHomeRoot: string | null;
  event: string;
  originUrl?: string | undefined;
}): string | null {
  const { repoRoot, runner, aiHomeRoot, event } = args;
  if (!aiHomeRoot || aiHomeRoot.length === 0) return null;

  let originUrl = args.originUrl;
  if (originUrl === undefined) {
    try {
      const result = runner(
        ["git", "-C", repoRoot, "remote", "get-url", "origin"],
        { check: false },
      );
      if (result.status !== 0) return null;
      originUrl = (result.stdout ?? "").trim();
    } catch {
      return null;
    }
  }
  if (!originUrl) return null;

  const segments = reverseDnsRepoSegments(originUrl);
  if (!segments) return null;

  // The event name is operator-controlled but flows through worktrunk;
  // refuse traversal and separators just like reverseDnsRepoSegments
  // does for owner/repo.
  if (!isSafeEventName(event)) return null;

  return join(aiHomeRoot, ".prx", "repos", ...segments, "hooks", event);
}

function isSafeEventName(s: string): boolean {
  return (
    s.length > 0 &&
    s !== "." &&
    s !== ".." &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("\0")
  );
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runEnsurePrxExcludes(ctx: {
  repoRoot: string;
  runner: CommandRunner;
  aiHomeRoot: string | null;
}): RunHookResult {
  const persisted = loadWorkspaceConfig(ctx.repoRoot, ctx.runner);
  const details = ensurePrxExcludes({
    repoRoot: ctx.repoRoot,
    workspaceTrack: persisted.track,
  });
  return {
    event: "ensure-prx-excludes",
    source: "builtin",
    repoRoot: ctx.repoRoot,
    exitCode: 0,
    builtin: { name: "ensure-prx-excludes", details },
  };
}

function runEnsureClaudeSettings(ctx: {
  repoRoot: string;
  runner: CommandRunner;
  aiHomeRoot: string | null;
}): RunHookResult {
  const details = ensureClaudeSettings({
    repoRoot: ctx.repoRoot,
    aiHomeRoot: ctx.aiHomeRoot,
  });
  return {
    event: "ensure-claude-settings",
    source: "builtin",
    repoRoot: ctx.repoRoot,
    exitCode: 0,
    builtin: { name: "ensure-claude-settings", details },
  };
}

export function formatRunHookResult(
  result: RunHookResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.source === "skipped") {
    if (result.reason === "no-repo") {
      return `run-hook ${result.event}: skipped (not inside a git repository)`;
    }
    if (result.reason === "unknown-event") {
      return `run-hook ${result.event}: skipped (no built-in and no override at ${result.overridePath ?? "<no overlay>"})`;
    }
    if (result.reason === "override-not-executable") {
      return `run-hook ${result.event}: skipped (override exists but is not executable: ${result.overridePath})`;
    }
    return `run-hook ${result.event}: skipped`;
  }
  if (result.source === "override") {
    return `run-hook ${result.event}: ran override ${result.overridePath} (exit ${result.exitCode})`;
  }
  return `run-hook ${result.event}: ran built-in (exit ${result.exitCode})`;
}
