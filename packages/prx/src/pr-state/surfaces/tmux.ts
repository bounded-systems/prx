/**
 * GH-872: read the live tmux server as the 5th parity surface.
 *
 * Single, batched query: `tmux -L prx list-sessions -F '<name>\t<path>'`.
 * No `has-session`, no `display-message` per row — the parity chain runs
 * once per `prx chain status` call and we don't want N+1 IPC over a
 * socket that may be slow under load.
 *
 * Failure is silent (returns an empty map): a missing tmux server, no
 * sessions, or a malformed line never throws. This is a read-only
 * surface — `muxSessionState`'s collision-throw lives in the create
 * path, not here.
 *
 * GH-1172: session names may now be mode-tagged (`<basename>-plan`,
 * `<basename>-implement`) so plan and implement sessions for the same
 * worktree coexist on the prx tmux socket. The map indexes on the
 * canonical work-unit id parsed from the *worktree path* basename
 * (unchanged), but each value is a list of one entry per
 * (ticket, mode) pair. Multi-mode is normal; same-(ticket, mode) duplicates
 * still flag `conflicted` for the parity chain.
 */
import { basename } from "node:path";

import {
  PRX_TMUX_SOCKET,
  defaultRunner,
  type CommandRunner,
} from "@bounded-systems/prx-mux";
import { parseCanonicalWorkUnitId } from "../../machine/work_unit.ts";
import {
  SESSION_CONTEXTS,
  type SessionContext,
} from "../../machine/machines/session-entry.ts";

export type TmuxSurfaceEntry = {
  sessionName: string;
  sessionPath: string;
  /**
   * GH-1172: parsed from the session-name suffix (`<basename>-plan` →
   * `"plan"`). Null for legacy un-suffixed sessions and for non-claude
   * paths (codex/copilot) that intentionally skip mode tagging.
   */
  mode: SessionContext | null;
  /** True when multiple sessions map to the same (ticket, mode) pair. */
  conflicted: boolean;
};

export type TmuxSurfaceMap = ReadonlyMap<string, ReadonlyArray<TmuxSurfaceEntry>>;

/**
 * Convert a worktrunk-style basename (`gh_872_bpt`, `notion_<32hex>_<slug>`)
 * to a canonical work-unit id (`GH-872`, `NOTION-<32hex>`). Returns null
 * for anything that doesn't pattern-match — main, mainx, and unrelated
 * tmux sessions on the prx socket are dropped.
 */
function workUnitIdFromBasename(name: string): string | null {
  const match = /^([A-Za-z]+)_([A-Za-z0-9]+)(?:_.*)?$/.exec(name);
  if (!match) return null;
  return parseCanonicalWorkUnitId(`${match[1]!.toUpperCase()}-${match[2]!}`);
}

/**
 * GH-1172: split a tmux session name into its `<basename>` and trailing
 * `<mode>` parts, when the suffix matches a known SessionContext.
 * Otherwise the mode is null and the whole name is treated as the basename
 * (back-compat with sessions created before mode-tagging landed).
 */
function parseModeFromSessionName(name: string): SessionContext | null {
  for (const ctx of SESSION_CONTEXTS) {
    if (name.endsWith(`-${ctx}`)) return ctx;
  }
  return null;
}

export function readTmuxSurface(runner: CommandRunner = defaultRunner): TmuxSurfaceMap {
  let result;
  try {
    result = runner(
      ["tmux", "-L", PRX_TMUX_SOCKET, "list-sessions", "-F", "#{session_name}\t#{session_path}"],
      { check: false },
    );
  } catch {
    // tmux binary missing, server unreachable, or test runner rejected the
    // command — surface reads must never crash the parity chain.
    return new Map();
  }
  if (result.status !== 0) {
    return new Map();
  }

  const map = new Map<string, TmuxSurfaceEntry[]>();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex < 0) continue;
    const sessionName = line.slice(0, tabIndex);
    const sessionPath = line.slice(tabIndex + 1);
    if (sessionName === "main" || sessionName === "mainx") continue;
    if (sessionPath.length === 0) continue;
    const ticket = workUnitIdFromBasename(basename(sessionPath.replace(/\/+$/, "")));
    if (!ticket) continue;
    const mode = parseModeFromSessionName(sessionName);
    const entries = map.get(ticket);
    if (!entries) {
      map.set(ticket, [{ sessionName, sessionPath, mode, conflicted: false }]);
      continue;
    }
    // Same-(ticket, mode) duplicate — flag every existing matching entry
    // and the new one as conflicted (preserves the GH-872 "two paths,
    // same name" semantic; multi-mode is no longer a conflict).
    const collisionIdx = entries.findIndex((e) => e.mode === mode);
    if (collisionIdx >= 0) {
      entries[collisionIdx] = { ...entries[collisionIdx]!, conflicted: true };
      entries.push({ sessionName, sessionPath, mode, conflicted: true });
    } else {
      entries.push({ sessionName, sessionPath, mode, conflicted: false });
    }
  }
  return map;
}

/**
 * GH-1172: pick the "primary" entry for a board-UI projection that today
 * exposes a single sessionName per unit. When both plan and implement are
 * live, implement wins (the operator is actively writing); otherwise the
 * first non-null mode wins, then the first un-suffixed entry. Returns null
 * when no entries exist.
 */
export function pickPrimaryTmuxEntry(
  entries: ReadonlyArray<TmuxSurfaceEntry>,
): TmuxSurfaceEntry | null {
  if (entries.length === 0) return null;
  const priority: ReadonlyArray<SessionContext | null> = [
    "implement",
    "plan",
    "triage",
    "intake",
    "mainx",
    null,
  ];
  for (const want of priority) {
    const hit = entries.find((e) => e.mode === want);
    if (hit) return hit;
  }
  return entries[0]!;
}
