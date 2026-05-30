/**
 * Worktree path resolution and execution — single source of truth.
 *
 * The canonical worktree path template is:
 *   ${XDG_STATE_HOME}/wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}
 *
 * This module resolves the template from:
 *   1. WT_WORKTREE_PATH env var (set by nix sessionVariables)
 *   2. XDG_STATE_HOME fallback (defaults to ~/.local/state)
 *
 * The resolved template is what worktrunk's WORKTRUNK_WORKTREE_PATH should be set to.
 *
 * `exec` delegates to the real worktrunk binary with the correct env and
 * writes a directive file for the parent shell to source.
 */

import { processEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Escape a string for safe use inside double-quoted shell values. */
function shellEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/\n/g, "\\n");
}

export const WT_SUBDIRECTORY = "wt/worktrees";
export const TEMPLATE_SUFFIX = "{{ repo }}/{{ branch | sanitize_db }}";

export type WorktreePathResult = {
  /** The resolved worktree path template (with {{ repo }} and {{ branch }} placeholders). */
  template: string;
  /** Where the template came from. */
  source: "WT_WORKTREE_PATH" | "XDG_STATE_HOME" | "default";
  /** The XDG_STATE_HOME value used (resolved or default). */
  xdgStateHome: string;
  /** The base directory (before {{ repo }}/{{ branch }}). */
  base: string;
  /** Environment variables that should be exported. */
  env: {
    WT_WORKTREE_PATH: string;
    WORKTRUNK_WORKTREE_PATH: string;
  };
};

export type WorktreePathEnv = {
  WT_WORKTREE_PATH?: string;
  XDG_STATE_HOME?: string;
  HOME?: string;
  PATH?: string;
  PPID?: string;
  WORKTRUNK_BIN?: string;
  WORKTRUNK_DIRECTIVE_SPOOL_FILE?: string;
};

/**
 * Resolve the canonical worktree path template.
 *
 * Priority:
 *   1. WT_WORKTREE_PATH (explicit, set by nix)
 *   2. XDG_STATE_HOME/wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}
 *   3. ~/.local/state/wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}
 */
export function resolveWorktreePath(env: WorktreePathEnv = processEnv() as WorktreePathEnv): WorktreePathResult {
  const home = env.HOME ?? "/tmp";

  // 1. Explicit WT_WORKTREE_PATH
  if (env.WT_WORKTREE_PATH) {
    const template = env.WT_WORKTREE_PATH;
    const base = template.replace(/\/\{\{.*$/, "");
    return {
      template,
      source: "WT_WORKTREE_PATH",
      xdgStateHome: env.XDG_STATE_HOME ?? `${home}/.local/state`,
      base,
      env: {
        WT_WORKTREE_PATH: template,
        WORKTRUNK_WORKTREE_PATH: template,
      },
    };
  }

  // 2. XDG_STATE_HOME
  const xdgStateHome = env.XDG_STATE_HOME ?? `${home}/.local/state`;
  const source = env.XDG_STATE_HOME ? "XDG_STATE_HOME" : "default";
  const base = `${xdgStateHome}/${WT_SUBDIRECTORY}`;
  const template = `${base}/${TEMPLATE_SUFFIX}`;

  return {
    template,
    source,
    xdgStateHome,
    base,
    env: {
      WT_WORKTREE_PATH: template,
      WORKTRUNK_WORKTREE_PATH: template,
    },
  };
}

export function formatWorktreePath(result: WorktreePathResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  return [
    `template:  ${result.template}`,
    `source:    ${result.source}`,
    `base:      ${result.base}`,
    `xdg-state: ${result.xdgStateHome}`,
    "",
    "Export:",
    `  WT_WORKTREE_PATH=${result.env.WT_WORKTREE_PATH}`,
    `  WORKTRUNK_WORKTREE_PATH=${result.env.WORKTRUNK_WORKTREE_PATH}`,
  ].join("\n");
}

export type WorktreeEnvResult = {
  /** Env vars to export for the wt wrapper. */
  vars: Record<string, string>;
  /** Shell snippet that can be eval'd. */
  shell: string;
};

/**
 * Produce the env vars the wt wrapper needs.
 * Output is suitable for eval in a shell script.
 */
export function worktreeEnv(env: WorktreePathEnv = processEnv() as WorktreePathEnv): WorktreeEnvResult {
  const path = resolveWorktreePath(env);
  const xdgStateHome = path.xdgStateHome;

  const vars: Record<string, string> = {
    WT_WORKTREE_PATH: path.template,
    WORKTRUNK_WORKTREE_PATH: path.template,
    WT_STATE_ROOT: xdgStateHome,
  };

  const shell = Object.entries(vars)
    .map(([k, v]) => `export ${k}="${shellEscape(v)}"`)
    .join("\n");

  return { vars, shell };
}

export function formatWorktreeEnv(result: WorktreeEnvResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return result.shell;
}

// ---------------------------------------------------------------------------
// exec: resolve binary, run worktrunk, write directive file
// ---------------------------------------------------------------------------

const SWITCH_DIRECTIVES = `\
if typeset -f _wt_apply_switch_env >/dev/null 2>&1; then _wt_apply_switch_env; fi
if typeset -f _wt_sync_main_after_switch >/dev/null 2>&1; then _wt_sync_main_after_switch; fi
if typeset -f _wt_auto_push_after_switch >/dev/null 2>&1; then _wt_auto_push_after_switch; fi
`;

export type ExecResult = {
  exitCode: number;
  directiveFile: string | null;
};

export type ExecOptions = {
  /** Args to pass to the real wt binary (e.g. ["switch", "GH-419"]). */
  args: string[];
  /** Use cargo run instead of the installed binary. */
  source?: boolean | undefined;
  /** Override WORKTRUNK_BIN. */
  worktrunkBin?: string | undefined;
  /** Override the directive spool path. */
  directiveSpoolFile?: string | undefined;
  /** Parent PID for directive file naming. */
  parentPid?: string | undefined;
};

/**
 * Resolve the real worktrunk binary.
 * Strips ~/.local/bin from PATH to avoid the wrapper calling itself.
 */
export function resolveWorktrunkBin(env: Record<string, string | undefined> = processEnv()): string | null {
  if (env.WORKTRUNK_BIN) return env.WORKTRUNK_BIN;

  const home = env.HOME ?? "/tmp";
  const localBin = `${home}/.local/bin`;
  const pathParts = (env.PATH ?? "").split(":").filter(p => p && p !== localBin);

  for (const dir of pathParts) {
    const candidate = `${dir}/wt`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Execute the real worktrunk binary with the resolved env.
 * Returns the exit code and the path to the directive file (if created).
 */
export function execWorktrunk(
  opts: ExecOptions,
  env: Record<string, string | undefined> = processEnv(),
): ExecResult {
  const resolved = worktreeEnv(env);
  const stateRoot = resolved.vars.WT_STATE_ROOT;
  const parentPid = opts.parentPid ?? env.PPID ?? process.pid.toString();
  const directiveFile = opts.directiveSpoolFile
    ?? env.WORKTRUNK_DIRECTIVE_SPOOL_FILE
    ?? `${stateRoot}/wt/directives/${parentPid}.zsh`;

  // Ensure directive directory exists and start with an empty file
  mkdirSync(dirname(directiveFile), { recursive: true });
  writeFileSync(directiveFile, "");

  // Build env for the child process
  const childEnv: Record<string, string> = {
    ...(env as Record<string, string>),
    ...resolved.vars,
    WORKTRUNK_DIRECTIVE_FILE: directiveFile,
  };

  let exitCode: number;

  // Redirect child stdout to stderr so it doesn't mix with the directive
  // path that the wrapper captures via command substitution.
  const childStdio: Array<"inherit" | "pipe" | "ignore" | number> = ["inherit", 2, "inherit"];

  // defaultRunner throws on a spawn error (e.g. the binary is missing);
  // check:false keeps a non-zero wt exit as a status, and a thrown spawn
  // failure maps to 1 — matching the prior `result.status ?? 1`.
  const runWorktrunk = (cmd: string[]): number => {
    try {
      return defaultRunner(cmd, { env: childEnv, stdio: childStdio, check: false }).status;
    } catch {
      return 1;
    }
  };

  if (opts.source) {
    exitCode = runWorktrunk(["cargo", "run", "--bin", "wt", "--quiet", "--", ...opts.args]);
  } else {
    const bin = opts.worktrunkBin ?? resolveWorktrunkBin(env);
    if (!bin) {
      process.stderr.write("wt: could not resolve the underlying binary; set WORKTRUNK_BIN to the real wt path\n");
      return { exitCode: 127, directiveFile: null };
    }
    exitCode = runWorktrunk([bin, ...opts.args]);
  }

  // Append switch directives on success
  const isSwitch = opts.args[0] === "switch";
  if (exitCode === 0 && isSwitch) {
    writeFileSync(directiveFile, SWITCH_DIRECTIVES, { flag: "a" });
  }

  // Clean up empty directive files
  const content = readFileSync(directiveFile, "utf8");
  if (!content.trim()) {
    unlinkSync(directiveFile);
    return { exitCode, directiveFile: null };
  }

  return { exitCode, directiveFile };
}

export function formatExecResult(result: ExecResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.directiveFile) {
    return result.directiveFile;
  }
  return "";
}
