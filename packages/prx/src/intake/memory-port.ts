// The prx-side agent-memory port (GH-1009 — first removal of bd's memory
// surface from prx, sub-issue of GH-1008 "retire beads").
//
// `prx intake bd memory {ls,get,set}` used to route through `execBd`
// (`bd memories`/`recall`/`remember`). That coupled prx's operator memory to
// the beads daemon. This port repoints those three commands onto
// `@bounded-systems/agent-memory` — a dolt-server-backed KV store that is a
// fully separate capability from beads (and from Front Desk).
//
// Why spawn a binary and not import agent-memory: agent-memory is async
// (mysql2 over the dolt-server wire protocol) but the intake verbs are
// SYNCHRONOUS. This mirrors bd-door-dialer.ts exactly — a single sync
// `agent-memory <verb>` spawn keeps the sync signature with no async ripple,
// and keeps the capability boundary a process boundary (agent-memory holds the
// dolt credentials; prx never does). The in-box wiring becomes a memory door
// (guest room) later, the same shape the beadsd door has.
//
// The `agent-memory` executable is resolved from PATH (override PRX_MEMORY_BIN),
// like `bd`. Memories are namespaced under one agent id (override
// PRX_MEMORY_AGENT, default "prx") so prx's operator memory is its own scope.

import { processEnv } from "@bounded-systems/env";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";

/** Minimal captured result shared with `emitBdResult` (no policy field). */
export type MemoryResult = { exitCode: number; stdout: string; stderr: string };

/**
 * The three memory operations the intake verbs need. `list` folds the
 * ls-vs-search choice (search present → substring search; absent → list) so the
 * caller expresses intent, not agent-memory's verb names.
 */
export interface MemoryPort {
  list(search: string | undefined, json: boolean): MemoryResult;
  recall(key: string, json: boolean): MemoryResult;
  remember(key: string, body: string, json: boolean): MemoryResult;
}

export type AgentMemoryPortDeps = {
  /** Sync command runner (default: the ambient-authority-approved procRunner). */
  run?: CommandRunner | undefined;
  /** The `agent-memory` executable (default: PRX_MEMORY_BIN ?? "agent-memory"). */
  bin?: string | undefined;
  /** The agent id memories are scoped to (default: PRX_MEMORY_AGENT ?? "prx"). */
  agent?: string | undefined;
  /** Ambient env source (default: the sanctioned processEnv). */
  env?: (() => Record<string, string>) | undefined;
};

const DEFAULT_MEMORY_BIN = "agent-memory";
const DEFAULT_MEMORY_AGENT = "prx";

/**
 * Build a {@link MemoryPort} that serves memory ops by spawning the
 * `agent-memory` CLI. JSON output is selected via `MEMORY_JSON=1` in the child
 * env — verbspec validates flags strictly against each verb's input schema, so
 * there is no `--json` flag to pass.
 */
export function makeAgentMemoryPort(deps: AgentMemoryPortDeps = {}): MemoryPort {
  const run = deps.run ?? procRunner;
  const readEnv = deps.env ?? processEnv;

  const call = (verb: string, args: string[], json: boolean): MemoryResult => {
    const e = readEnv();
    const bin = deps.bin ?? e.PRX_MEMORY_BIN ?? DEFAULT_MEMORY_BIN;
    const agent = deps.agent ?? e.PRX_MEMORY_AGENT ?? DEFAULT_MEMORY_AGENT;
    const env = json ? { ...e, MEMORY_JSON: "1" } : e;
    const r = run([bin, verb, "--agent", agent, ...args], { check: false, env });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  return {
    list: (search, json) =>
      search ? call("search", ["--query", search], json) : call("list", [], json),
    recall: (key, json) => call("recall", ["--key", key], json),
    remember: (key, body, json) => call("remember", ["--key", key, "--value", body], json),
  };
}

/** The default production port (spawns `agent-memory` on PATH). */
export const agentMemoryPort: MemoryPort = makeAgentMemoryPort();
