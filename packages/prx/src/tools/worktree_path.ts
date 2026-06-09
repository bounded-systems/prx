/**
 * Worktree path resolution — single source of truth.
 *
 * The canonical worktree path template is:
 *   ${XDG_STATE_HOME}/wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}
 *
 * This module resolves the template from:
 *   1. WT_WORKTREE_PATH env var (set by nix sessionVariables)
 *   2. XDG_STATE_HOME fallback (defaults to ~/.local/state)
 *
 * Used by `prx repo *` and `prx gc` to locate the worktree base directory.
 * (prx-arl retired the worktrunk-binary exec path that used to live here; prx
 * now owns the worktree lifecycle through its own WorktreeCreate/Remove hooks.)
 */

import { processEnv } from "@bounded-systems/env";

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
