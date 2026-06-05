/**
 * Invariant: NO prx agent is launched without a signing key.
 *
 * Every actor in the pipeline signs what it does (the in-toto chain). An agent
 * with no key could act with no attributable, signed owner — the T3 hole the
 * capability model exists to close. So agent launch is gated on a resolvable
 * `Signer`; absence is a hard refusal, not a silent fail-open.
 *
 * The human is an actor too. The CLI process is "an actor that inherits from a
 * tty": when stdin is a controlling terminal the actor IS the human operator,
 * and that human must hold a signing key like any other actor. Non-interactive
 * invocations (pipes, CI, headless) are the `noninteractive` actor — still
 * key-gated.
 */

import { resolveProvenanceSigner } from "../provenance/signer.ts";
import type { Signer } from "../machine/machines/pilot-signing.ts";

export type SignerResolver = () => Signer | null;

const defaultResolve: SignerResolver = () => resolveProvenanceSigner() as Signer | null;

/**
 * Resolve the signing key for `actorLabel` or REFUSE to launch. This is the
 * chokepoint every agent-launch path must pass through.
 */
export function requireSigner(actorLabel: string, resolve: SignerResolver = defaultResolve): Signer {
  const signer = resolve();
  if (!signer) {
    throw new Error(
      `refusing to launch the ${actorLabel} agent: every prx actor must hold a signing key ` +
        `(no agent acts unsigned). Set PRX_PROVENANCE_KEY=dev for the persisted dev key, ` +
        `or ed25519:<b64> for a stable identity.`,
    );
  }
  return signer;
}

export type CliActor = {
  /** The actor identity this CLI invocation acts as. */
  actor: string;
  /** True when launched from a controlling tty (the human is present). */
  interactive: boolean;
};

/**
 * The CLI is an actor whose identity inherits from the controlling tty. A real
 * terminal ⇒ the human operator; a pipe / CI / headless context ⇒ the
 * `noninteractive` actor. `isTTY`/`user` are injectable for tests.
 */
export function cliActor(opts: { isTTY?: boolean; user?: string } = {}): CliActor {
  const isTTY = opts.isTTY ?? Boolean((globalThis as { process?: { stdin?: { isTTY?: boolean } } }).process?.stdin?.isTTY);
  return { actor: isTTY ? opts.user ?? "human" : "noninteractive", interactive: isTTY };
}

/**
 * The CLI actor must hold a signing key too — the human signs, like every
 * actor. Returns the resolved actor + its signer, or throws.
 */
export function requireCliSigner(
  opts: { isTTY?: boolean; user?: string; resolve?: SignerResolver } = {},
): { actor: CliActor; signer: Signer } {
  const actor = cliActor(opts);
  const signer = requireSigner(`cli (${actor.actor})`, opts.resolve);
  return { actor, signer };
}
