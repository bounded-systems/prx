import { basename } from "node:path";

/**
 * Layout for a prx tmux session. v1: a single pane running the
 * agent/shell. Multi-pane layouts were removed in GH-767 — the
 * previous 4-pane default (editor/tests/agent/logs) only ever had
 * the agent pane populated in practice.
 *
 * The two fields are mutually exclusive. Callers choose one:
 * - `bootstrap_command` — shell replays the command via `send-keys`.
 *   Pane tree is `shell → agent`; exiting the agent drops to the
 *   shell.
 * - `pane_command` — tmux execs argv directly (GH-819). Pane tree is
 *   `tmux → agent` (agent is PID 1); exiting the agent closes the
 *   pane (or `[exited]` if `remain_on_exit` is set).
 */
export interface PrxLayout {
  /**
   * Optional shell command replayed into the pane via `send-keys`
   * once the session is created. Also what tmux-resurrect replays
   * for bootstrap_command on restore.
   */
  bootstrap_command?: string;
  /**
   * Optional argv exec'd as pane PID 1 (tmux's trailing `[shell-command]`
   * on `new-session`). No shell parent, no `send-keys` — the pane is
   * the agent process itself.
   */
  pane_command?: {
    argv: string[];
    /**
     * When true, emits `set-window-option remain-on-exit failed` on
     * the session's first window so the pane sticks around in
     * `[exited]` state only when the agent exits non-zero. Clean exits
     * (status 0) close the pane. Useful for reading the final
     * scrollback after a crash without paying the friction of a
     * lingering pane on every clean `/exit`.
     */
    remain_on_exit?: boolean;
  };
}

/**
 * Sanitized pure function mapping a worktree path to a tmux session
 * name. Uses the directory basename because that's what worktrunk
 * produces (`gh_<n>_<slug>` since GH-495) and is unique-per-path on
 * this host. Any byte outside `[A-Za-z0-9_-]` is replaced with `_` so
 * the result is safe as a tmux target (tmux rejects `:` and `.` in
 * session names).
 *
 * GH-1172: when `mode` is provided, the suffix `-<sanitizedMode>` is
 * appended so a single worktree can host multiple coexisting sessions
 * (e.g. `gh_1172_c5h-plan` and `gh_1172_c5h-implement`). Tmux rejects
 * `:` in session names, so `-` is the on-disk separator; status-line
 * renderers may still display `:plan` / `:implement` for visual style.
 *
 * A collision — two distinct worktree paths that sanitize to the same
 * name — is detected at `muxSessionState` time rather than here,
 * because detection requires talking to the running tmux server.
 */
/**
 * Trim trailing slashes without a backtracking regex. `/\/+$/` is flagged as
 * polynomial-ReDoS (CodeQL js/polynomial-redos) on paths with many trailing
 * `/`; this scans from the end in linear time instead.
 */
function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  return p.slice(0, end);
}

export function muxSessionName(worktreePath: string, mode?: string): string {
  const raw = basename(stripTrailingSlashes(worktreePath));
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (sanitized.length === 0) {
    throw new Error(`muxSessionName: empty session name derived from ${JSON.stringify(worktreePath)}`);
  }
  if (mode === undefined) {
    return sanitized;
  }
  const sanitizedMode = mode.replace(/[^A-Za-z0-9_-]/g, "_");
  if (sanitizedMode.length === 0) {
    throw new Error(`muxSessionName: empty mode suffix derived from ${JSON.stringify(mode)}`);
  }
  return `${sanitized}-${sanitizedMode}`;
}

/** A single step in a compiled layout script — one tmux IPC call. */
export interface MuxStep {
  args: string[];
}

/**
 * Compile a layout into an ordered list of tmux IPC calls. Single
 * pane. Two shapes:
 *
 * - `pane_command` set (GH-819): emit one `new-session` with the argv
 *   as tmux's trailing `[shell-command]`, so the pane's PID 1 is the
 *   agent process itself (no shell parent, no `send-keys`). When
 *   `remain_on_exit` is true, also set `remain-on-exit failed` on the
 *   session's first window so the pane sticks around as `[exited]`
 *   only when the agent exits non-zero (clean exits close).
 * - `bootstrap_command` set (legacy): `new-session -d` creates the
 *   session with the shell in the sole pane, then `send-keys` replays
 *   the bootstrap into it.
 * - Neither: bare detached session (the shell runs on its own).
 *
 * The window is named `worktree` so Warp (and anything else reading
 * the tmux window name) has a stable label.
 */
export function compileLayout(sessionName: string, worktreeCwd: string, layout: PrxLayout): MuxStep[] {
  if (layout.pane_command && layout.bootstrap_command) {
    throw new Error(
      "compileLayout: pane_command and bootstrap_command are mutually exclusive (GH-819). " +
      "pane_command execs argv directly as pane PID 1; bootstrap_command replays into a shell parent. " +
      "Pick one.",
    );
  }
  const baseNewSessionArgs = ["new-session", "-d", "-s", sessionName, "-c", worktreeCwd, "-n", "worktree"];
  if (layout.pane_command) {
    const steps: MuxStep[] = [
      { args: [...baseNewSessionArgs, ...layout.pane_command.argv] },
    ];
    if (layout.pane_command.remain_on_exit) {
      steps.push({
        args: ["set-window-option", "-t", `${sessionName}:worktree`, "remain-on-exit", "failed"],
      });
    }
    return steps;
  }
  const steps: MuxStep[] = [{ args: baseNewSessionArgs }];
  if (layout.bootstrap_command) {
    steps.push({ args: ["send-keys", "-t", sessionName, layout.bootstrap_command, "Enter"] });
  }
  return steps;
}
