// The prx-side beadsd door dialer (prx-asr / prx-634).
//
// `@bounded-systems/bd` stays daemon-agnostic: in the box profile (PRX_BEADS_DOOR
// set) `execBd` refuses to spawn a local `bd` and instead asks a registered
// dialer to serve the op over the door. This module IS that dialer — it lives in
// prx because the door knowledge (which `prx beads` verb expresses which bd
// subcommand) is prx's, not bd's. `registerBdDoorDialer(prxBeadsDoorDialer)` is
// wired once at CLI startup (runCli).
//
// Why a `prx beads` subprocess and not `withBeadsClient` directly: the door is
// async but `execBd` is SYNCHRONOUS (called deep inside sync verb code). This
// mirrors `loadAllBeadsViaCli` (triage/beads-daemon-loader.ts) exactly — a
// single sync `prx beads <verb>` spawn runs the same daemon query in its own
// process, keeping execBd's sync signature with no async ripple. It is
// recursion-safe: `prx beads <verb>` reads via withBeadsClient (the socket
// door), NOT back through execBd, so the spawn cannot re-enter here.
//
// Scope (prx-asr / prx-634 unblock the rest): only the READ surface
// (list/ready/show) is expressible over the door today — that covers
// `prx intake bd ls`. Writes and the memory/sql/admin surface return `null`, so
// execBd fails CLOSED with the door-not-wired message rather than silently
// dropping a mutation. The in-box write-door is a separate, blocked concern.

import type { BdDoorDialer, BdExecResult } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";

/** The `prx` executable to invoke for the door round-trip. */
const DEFAULT_PRX_BINARY = "prx";

// bd subcommand → `prx beads <verb>`. Only reads map; the verb name happens to
// match the bd subcommand 1:1, but the table keeps the allowlist explicit (an
// unmapped subcommand is not dialable and falls through to fail-closed).
const DOOR_READ_VERBS: Readonly<Record<string, string>> = {
  list: "list",
  ready: "ready",
  show: "show",
};

export type PrxBeadsDoorDialerDeps = {
  /** Sync command runner (default: the ambient-authority-approved procRunner). */
  run?: CommandRunner | undefined;
  /** The `prx` executable (default: "prx" on PATH). */
  prxBinary?: string | undefined;
};

/**
 * Build a {@link BdDoorDialer} that serves bd reads over the beadsd door by
 * spawning the equivalent `prx beads <verb>`. Returns `null` for any op not on
 * the door read surface so {@link execBd} fails closed instead of spawning bd.
 */
export function makePrxBeadsDoorDialer(deps: PrxBeadsDoorDialerDeps = {}): BdDoorDialer {
  const run = deps.run ?? procRunner;
  const bin = deps.prxBinary ?? DEFAULT_PRX_BINARY;

  return (opts): BdExecResult | null => {
    const verb = DOOR_READ_VERBS[opts.subcommand];
    if (!verb) {
      // Not expressible over the door read surface — caller fails closed.
      return null;
    }

    // Forward the caller's args verbatim after the verb: `--status` / `--limit`
    // / `--json` (list), `--explain` / `--json` (ready), `<id>` / `--json`
    // (show) are the same flags `prx beads <verb>` already parses.
    const result = run([bin, "beads", verb, ...opts.args], { check: false });

    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      policy: null,
    };
  };
}

/** The default production dialer (registered at CLI startup). */
export const prxBeadsDoorDialer: BdDoorDialer = makePrxBeadsDoorDialer();
