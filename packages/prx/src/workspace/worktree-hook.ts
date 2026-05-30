// ai-home-ozbjp — the workcell WorktreeCreate/WorktreeRemove hook layer.
//
// Envelope-first (operator steer 2026-05-30): define + test the BOUNDARY now;
// verify the runtime satisfies it later. Claude Code's `--worktree` /
// `isolation: "worktree"` fire documented hooks that replace its default git
// behavior:
//   - WorktreeCreate: stdin `{ name }` → the hook MUST print the absolute
//     worktree path on stdout; ANY non-zero exit aborts creation.
//   - WorktreeRemove: stdin `{ worktree_path }` → cleanup; no decision control
//     (failures are logged only), so it always exits 0.
//
// This module is the deterministic hook body over two PORTS — `materialize`
// (name → worktree path) and `teardown` (path → void) — which the prx runtime
// (reserve → workspace.materialize / teardown) satisfies in a later slice. The
// ports are injected so the whole boundary is mock-testable without a real
// `claude --worktree` launch or git state.

/**
 * The Claude Code worktree-hook stdin envelope (the boundary contract). Only
 * the fields the hooks use are typed; parsing is tolerant of the rest.
 */
export interface WorktreeEnvelope {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  /** WorktreeCreate: the slug for the worktree to create. */
  name?: string;
  /** WorktreeRemove: the absolute path of the worktree being removed. */
  worktree_path?: string;
}

/** Parse a worktree-hook stdin envelope; tolerant of empty/malformed input. */
export function parseWorktreeEnvelope(stdin: string): WorktreeEnvelope {
  if (typeof stdin !== "string" || stdin.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(stdin);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as WorktreeEnvelope)
      : {};
  } catch {
    return {};
  }
}

export interface WorktreeHookResult {
  /** 0 allows the operation; non-zero from WorktreeCreate aborts creation. */
  exitCode: number;
  /** WorktreeCreate success → the path (stdout, Claude reads it as the cwd). */
  message: string;
  /** Which stream `message` goes to. */
  stream: "stdout" | "stderr";
}

/**
 * The runtime contract WorktreeCreate must later satisfy: given Claude Code's
 * worktree `name`, materialize a worktree and return its absolute path (throws
 * on failure). The prx runtime implements this via reserve → workspace.materialize.
 */
export type MaterializePort = (name: string) => Promise<string>;

/** The runtime contract WorktreeRemove later satisfies: tear down the worktree. */
export type TeardownPort = (worktreePath: string) => Promise<void>;

/**
 * WorktreeCreate hook body: parse the envelope, materialize via the port, print
 * the path (exit 0) or fail loud (non-zero → Claude Code aborts creation rather
 * than start a session in a half-made worktree).
 */
export async function runWorktreeCreateHook(deps: {
  stdin: string;
  materialize: MaterializePort;
}): Promise<WorktreeHookResult> {
  const name = parseWorktreeEnvelope(deps.stdin).name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return {
      exitCode: 1,
      stream: "stderr",
      message: "WorktreeCreate: envelope missing `name` — cannot materialize",
    };
  }
  try {
    const path = await deps.materialize(name);
    if (typeof path !== "string" || path.trim().length === 0) {
      return {
        exitCode: 1,
        stream: "stderr",
        message: `WorktreeCreate: materialize returned no path for ${name}`,
      };
    }
    return { exitCode: 0, stream: "stdout", message: path };
  } catch (err) {
    return {
      exitCode: 1,
      stream: "stderr",
      message: `WorktreeCreate: materialize failed for ${name}: ${(err as Error).message}`,
    };
  }
}

/**
 * WorktreeRemove hook body: parse the envelope, tear down via the port. No
 * decision control (the contract can't block removal), so it always exits 0;
 * a missing path or a teardown failure is reported to stderr (logged only).
 */
export async function runWorktreeRemoveHook(deps: {
  stdin: string;
  teardown: TeardownPort;
}): Promise<WorktreeHookResult> {
  const path = parseWorktreeEnvelope(deps.stdin).worktree_path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return {
      exitCode: 0,
      stream: "stderr",
      message: "WorktreeRemove: envelope has no `worktree_path`; nothing to do",
    };
  }
  try {
    await deps.teardown(path);
    return { exitCode: 0, stream: "stdout", message: `removed ${path}` };
  } catch (err) {
    return {
      exitCode: 0,
      stream: "stderr",
      message: `WorktreeRemove: teardown failed for ${path}: ${(err as Error).message}`,
    };
  }
}

export interface WorktreeHookSettings {
  hooks: {
    WorktreeCreate: Array<{ hooks: Array<{ type: "command"; command: string }> }>;
    WorktreeRemove: Array<{ hooks: Array<{ type: "command"; command: string }> }>;
  };
}

/**
 * Settings registering the prx worktree hooks (replacing Claude Code's default
 * git-worktree behavior with prx materialization). `createCommand` /
 * `removeCommand` run the tracked hook scripts, e.g.
 * `bun ${CLAUDE_PROJECT_DIR}/scripts/hooks/worktree-create.ts`.
 */
export function buildWorktreeHookSettings(
  createCommand: string,
  removeCommand: string,
): WorktreeHookSettings {
  return {
    hooks: {
      WorktreeCreate: [{ hooks: [{ type: "command", command: createCommand }] }],
      WorktreeRemove: [{ hooks: [{ type: "command", command: removeCommand }] }],
    },
  };
}
