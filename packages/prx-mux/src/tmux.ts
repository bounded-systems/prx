import { readFileSync, openSync, writeSync, ftruncateSync, closeSync, existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { defaultRunner, type CommandResult, type CommandRunner } from "@bounded-systems/proc";

import { compileLayout, type PrxLayout } from "./layout.ts";

/**
 * Single prx-owned tmux socket. Chosen over per-session sockets
 * (`-L prx-gh-<n>`) because cross-session IPC via `list-sessions`,
 * `has-session`, and resurrect server-wide save/restore all stay on
 * one server (decision doc §6 / lifecycle spec §9.6). `-L prx` is
 * passed on every tmux invocation so the module never touches the
 * user's default tmux server.
 */
export const PRX_TMUX_SOCKET = "prx";

export type MuxSessionState = "absent" | "running-detached" | "running-attached" | "exited-resurrectable";

/**
 * Home-manager module Slice 1 sets `@resurrect-dir` to this path; the
 * driver reads it directly so worktree-remove can clean its entry
 * without shelling out to tmux (which may be dead).
 */
export const PRX_RESURRECT_DIR = `${homedir()}/.local/state/prx/tmux-resurrect/`;

function tmux(cmd: string[]): string[] {
  return ["tmux", "-L", PRX_TMUX_SOCKET, ...cmd];
}

function trimStdout(result: CommandResult): string {
  return result.stdout.replace(/\n+$/, "");
}

/**
 * Detect which of the 4 observable lifecycle states a session is in.
 * The lifecycle spec §3 lists 5 states; the 5th (`gone`) is a
 * post-cleanup marker rather than something we query for, so this
 * function only returns the 4 reachable states.
 *
 * The collision guard described in design D2 fires when a session
 * with the derived name exists on the socket but for a different
 * `session_path` than the worktree the caller resolved — that
 * condition raises rather than returning a misleading running-*
 * state.
 *
 * `exited-resurrectable` is detected via the tmux-resurrect `last`
 * symlink under PRX_RESURRECT_DIR: if the server is dead but a save
 * file exists naming this session, state is "exited-resurrectable".
 */
export function muxSessionState(
  name: string,
  expectedCwd: string,
  run: CommandRunner = defaultRunner,
): MuxSessionState {
  const has = run(tmux(["has-session", "-t", name]), { check: false });
  if (has.status !== 0) {
    if (resurrectSaveMentions({ name })) {
      return "exited-resurrectable";
    }
    return "absent";
  }

  const sessionPath = run(tmux(["display-message", "-p", "-t", name, "#{session_path}"]), { check: false });
  if (sessionPath.status === 0) {
    const actual = trimStdout(sessionPath);
    const normalizedActual = actual ? resolve(actual) : actual;
    const normalizedExpected = resolve(expectedCwd);
    if (actual && normalizedActual !== normalizedExpected) {
      throw new Error(
        `tmux session '${name}' already exists on socket -L ${PRX_TMUX_SOCKET} for a different worktree ` +
        `(session_path='${actual}', expected='${expectedCwd}'). ` +
        `Rename or kill that session before opening this one: \`tmux -L ${PRX_TMUX_SOCKET} kill-session -t ${name}\`.`,
      );
    }
  }

  const attached = run(tmux(["display-message", "-p", "-t", name, "#{session_attached}"]), { check: false });
  const count = attached.status === 0 ? Number.parseInt(trimStdout(attached), 10) || 0 : 0;
  return count > 0 ? "running-attached" : "running-detached";
}

/**
 * Create a new detached session and replay any bootstrap command.
 * On any step failure the session is killed so we don't leave a
 * half-initialized shell behind.
 */
export function spawnMuxSession(opts: {
  name: string;
  cwd: string;
  layout: PrxLayout;
  run?: CommandRunner | undefined;
}): void {
  const run = opts.run ?? defaultRunner;
  const steps = compileLayout(opts.name, opts.cwd, opts.layout);

  for (const step of steps) {
    try {
      run(tmux(step.args), { check: true });
    } catch (err) {
      try {
        run(tmux(["kill-session", "-t", opts.name]), { check: false });
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  }
}

/**
 * Send a keystroke sequence into the primary pane of a live session
 * via `tmux send-keys`. `submit` defaults to true and appends a
 * trailing `Enter`; callers that want to pre-fill a command without
 * submitting it (e.g. billing-confirmation flows) pass `submit: false`.
 *
 * The socket flag `-L prx` matches every other helper in this module,
 * so the call targets the prx-owned tmux server.
 */
export function sendMuxKeys(opts: {
  name: string;
  keys: string;
  submit?: boolean | undefined;
  run?: CommandRunner | undefined;
}): void {
  const run = opts.run ?? defaultRunner;
  const target = `${opts.name}:worktree.0`;
  const args = ["send-keys", "-t", target, "--", opts.keys];
  if (opts.submit !== false) args.push("Enter");
  run(tmux(args), { check: true });
}

/**
 * Run `tmux attach-session` for the named session as a synchronous
 * child process. By default stdio is inherited, so the caller's
 * terminal is attached directly to tmux until the user detaches or
 * the server exits; this function then returns tmux's exit status
 * (mapped to `128 + signum` when the child was terminated by a
 * signal, per shell convention).
 */
export function attachMuxSession(opts: {
  name: string;
  stdio?: "inherit" | "pipe" | undefined;
  run?: CommandRunner | undefined;
}): CommandResult {
  const run = opts.run ?? defaultRunner;
  const argv = tmux(["attach-session", "-t", opts.name]);
  // Interactive by default: an attach wires the caller's terminal straight
  // through (stdio: inherit). The spawn itself goes through @bounded-systems/proc so this
  // tool call is a visible dependency edge, not a raw subprocess.
  return run(argv, { check: false, stdio: opts.stdio ?? "inherit" });
}

/**
 * Terminate a session and drop its resurrect entry. Order: detach
 * any clients → kill-session → clear save-file entry. Detach
 * first so clients don't see a hung attach; the kill-session alone
 * will drop them anyway but the explicit detach gives a cleaner
 * UX.
 *
 * `clearResurrectEntry` is separated so callers (removeWorktree)
 * can invoke it on a never-started session that has only a stale
 * save-file entry.
 */
export function killMuxSession(opts: {
  name: string;
  run?: CommandRunner | undefined;
  resurrectDir?: string | undefined;
}): void {
  const run = opts.run ?? defaultRunner;
  run(tmux(["detach-client", "-s", opts.name]), { check: false });
  run(tmux(["kill-session", "-t", opts.name]), { check: false });
  clearResurrectEntry({ name: opts.name, resurrectDir: opts.resurrectDir });
}

/**
 * Remove any line mentioning `name` from the tmux-resurrect current
 * save file (the target of the `last` symlink under PRX_RESURRECT_DIR).
 * No-op when the save file doesn't exist or can't be read.
 *
 * tmux-resurrect's save-file format is tab-separated: each line
 * starts with a record kind (`pane`, `window`, `state`, `grouped_session`),
 * followed by fields where `session_name` is column 2 for `pane` and
 * `window` and the whole line for `state`. We filter conservatively:
 * drop any line whose tab-split second column equals the session
 * name; leave everything else untouched.
 */
export function clearResurrectEntry(opts: { name: string; resurrectDir?: string | undefined }): void {
  const dir = opts.resurrectDir ?? PRX_RESURRECT_DIR;
  const lastPath = `${dir.replace(/\/?$/, "/")}last`;
  // Resolve the resurrect "last" symlink (if it is one) without a stat/exists
  // pre-check: readlink returns null for a non-symlink, broken, or missing
  // path, and the open below surfaces a missing/unreadable target. Checking the
  // path first and then opening it is a TOCTOU race (CodeQL js/file-system-race).
  const target = tryReadlink(lastPath);
  const savePath = target
    ? (isAbsolute(target) ? target : resolve(dirname(lastPath), target))
    : lastPath;
  // Read and rewrite through a single descriptor so the filter-and-write is
  // atomic against the read.
  let fd: number;
  try {
    fd = openSync(savePath, "r+");
  } catch {
    return;
  }
  try {
    const contents = readFileSync(fd, "utf8");
    const filtered = contents
      .split("\n")
      .filter((line) => {
        if (line.length === 0) return true;
        const parts = line.split("\t");
        return parts[1] !== opts.name;
      })
      .join("\n");

    if (filtered === contents) {
      return;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, filtered, 0);
  } catch {
    // Non-fatal: a permission error here should not block worktree removal.
  } finally {
    closeSync(fd);
  }
}

function tryReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Fires tmux-resurrect's global restore. Server-wide: all sessions
 * present in the `last` save file come back. This is the v1 fidelity
 * documented in decision doc §5 — per-session restore requires a
 * custom resurrect save/restore strategy script that is not in scope
 * for this slice. In practice the home-manager default of
 * `@continuum-restore 'off'` means this only fires when the driver
 * calls it, so the "no surprise on unrelated session open" property
 * is preserved whenever the caller guards on `muxSessionState ===
 * "exited-resurrectable"` for the specific session.
 *
 * Script discovery: when `restoreScript` isn't provided explicitly
 * (tests), we query the tmux server's `@prx-resurrect-script` user
 * option. home-manager's `programs.tmux-prx` module sets this to the
 * nix-store path of `tmux-resurrect`'s `scripts/restore.sh` at
 * home-manager build time, so the driver doesn't have to parse
 * `tmux.conf` or shell out to `nix eval` at runtime.
 */
export function restoreMuxSession(opts: { run?: CommandRunner; restoreScript?: string }): void {
  const run = opts.run ?? defaultRunner;
  const restoreScript = opts.restoreScript ?? discoverResurrectRestoreScript(run);
  if (!restoreScript) {
    throw new Error(
      "restoreMuxSession: could not discover tmux-resurrect restore.sh. " +
      "Either pass opts.restoreScript explicitly or ensure `programs.tmux-prx.enable = true` in home-manager " +
      "(which sets `@prx-resurrect-script` on the running tmux server).",
    );
  }
  run(tmux(["run-shell", restoreScript]), { check: true });
}

/**
 * Read the `@prx-resurrect-script` user option from the running tmux
 * server. Returns the configured nix-store path to `restore.sh`, or
 * null if the option isn't set (e.g. the server predates the Slice 5
 * home-manager update, or tmux-prx isn't enabled).
 */
function discoverResurrectRestoreScript(run: CommandRunner): string | null {
  const result = run(tmux(["show-option", "-gqv", "@prx-resurrect-script"]), { check: false });
  if (result.status !== 0) return null;
  const path = result.stdout.replace(/\n+$/, "");
  return path.length > 0 ? path : null;
}

/**
 * Probe whether the tmux-resurrect save file under `resurrectDir`
 * mentions `name`. Read-only counterpart to `clearResurrectEntry`;
 * returns false when the save file is missing or unreadable. Used by
 * the GH-1133 session-prune builder to decide whether to emit a
 * `close_prx_session` action even when the live tmux server has no
 * active session of that name.
 */
export function resurrectSaveMentions(opts: { name: string; resurrectDir?: string }): boolean {
  const savePath = resolveResurrectLast(opts.resurrectDir);
  if (!savePath) return false;
  let contents: string;
  try {
    contents = readFileSync(savePath, "utf8");
  } catch {
    return false;
  }
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts[1] === opts.name) return true;
  }
  return false;
}

function resolveResurrectLast(resurrectDir?: string): string | null {
  const dir = resurrectDir ?? PRX_RESURRECT_DIR;
  const lastPath = `${dir.replace(/\/?$/, "/")}last`;
  if (!existsSync(lastPath)) return null;
  const target = tryReadlink(lastPath);
  if (target) {
    return isAbsolute(target) ? target : resolve(dirname(lastPath), target);
  }
  return lastPath;
}
