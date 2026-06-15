// prx-44y — route the handoff queue's bd memory ops through the beadsd daemon.
//
// The structured-handoff store (store.ts) reads/writes its rows on bd's memory
// surface (`bd remember` / `recall` / `memories`) via the synchronous `execBd`.
// From a worktree, raw `bd` never reaches the ONE canonical clone the daemon
// owns — so `prx handoff enqueue` reported `created` while the row landed in a
// phantom (or no) store and `prx handoff status` read nothing.
//
// This adapter is a drop-in for `execBd` (same signature) that, instead of
// spawning a raw `bd <subcommand>`, spawns `prx beads <subcommand> <args>` —
// which reaches the canonical clone through `withBeadsClient` (auto-started
// daemon off-profile; the box socket in the box profile). Two properties matter:
//
//   • SYNCHRONOUS, mirroring `execBd`: `claimHandoff` does a read-then-write
//     with no awaits between, relying on the single blocking sequence as a
//     best-effort CAS. A sync subprocess spawn preserves that exactly (an async
//     daemon client would insert an await and widen the window).
//   • Recursion-safe: `prx beads <verb>` reaches the store via the socket door
//     (the same path the dialer uses), never back through this adapter.
//
// `prx beads` re-emits the daemon's parsed `result` as JSON, so the stdout the
// store parses (`parseMemoriesJson`) and the exit code it checks are shaped
// exactly as the raw `bd --json` they replace.

import {
  execBd as defaultExecBd,
  type BdExecEnv,
  type BdExecOptions,
  type BdExecResult,
} from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";

/** The `prx` executable to invoke for the daemon round-trip (on PATH). */
const DEFAULT_PRX_BINARY = "prx";

export type HandoffDaemonBdDeps = {
  /** Sync command runner (default: the ambient-authority-approved procRunner). */
  run?: CommandRunner | undefined;
  /** The `prx` executable (default: "prx" on PATH). */
  prxBinary?: string | undefined;
};

/**
 * Build an `execBd`-shaped adapter that routes a bd op through `prx beads`.
 * Args are forwarded verbatim after the verb — the `prx beads` memory verbs
 * (`remember <body> --key <key>`, `recall <key>`, `memories [<prefix>]`) parse
 * the same flags the store already passes (`--key`, `--json`).
 */
export function makeHandoffDaemonBd(deps: HandoffDaemonBdDeps = {}): typeof defaultExecBd {
  const run = deps.run ?? procRunner;
  const bin = deps.prxBinary ?? DEFAULT_PRX_BINARY;
  const adapter = (opts: BdExecOptions, _env?: BdExecEnv): BdExecResult => {
    const result = run([bin, "beads", opts.subcommand, ...opts.args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      check: false,
    });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, policy: null };
  };
  return adapter as typeof defaultExecBd;
}

/** The production handoff bd adapter (daemon-routed). */
export const handoffDaemonBd: typeof defaultExecBd = makeHandoffDaemonBd();
