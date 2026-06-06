/**
 * Unified beads client — the one door host code uses to reach beads (GH-296).
 *
 * The migration model is "require beadsd up": prx reaches beads through the
 * daemon, never local `execBd`. This factory resolves the beadsd endpoint (a
 * local unix socket, or a configured Lima VM) and hands back an
 * {@link IsolatedBeadsClient}, failing fast with an actionable error when the
 * daemon isn't reachable — so a missing daemon is a clear "start beadsd"
 * message, not an opaque socket error.
 *
 * Foundation only: this adds the door; it does NOT yet route the ~280 execBd
 * call sites through it (the waves) and does NOT auto-start a local daemon (a
 * follow-up). Existing code is untouched until call sites adopt `withBeadsClient`.
 */

import { getEnv } from "@bounded-systems/env";

import { IsolatedBeadsClient } from "./client.ts";
import { withLimaBeadsClient, type LimaBeadsChannelDeps } from "./lima.ts";
import { unixSocketTransport, type FramedTransport } from "../keeperd/transport.ts";

/** Where beadsd lives: a local unix socket, or a daemon inside a Lima VM. */
export type BeadsEndpoint =
  | { readonly kind: "local"; readonly socket: string }
  | { readonly kind: "lima"; readonly vm: string; readonly vmSocket: string };

/** Default local beadsd socket (override with `PRX_BEADS_SOCKET`). */
export const DEFAULT_LOCAL_BEADS_SOCKET = "/tmp/prx-beadsd.sock";
/** Default in-VM beadsd socket (matches the BEADS_SPEC default). */
export const DEFAULT_VM_BEADS_SOCKET = "/tmp/beadsd.sock";

/** Thrown when beadsd isn't reachable — carries an actionable "start it" message. */
export class BeadsUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BeadsUnavailableError";
  }
}

/**
 * Resolve the beads endpoint from the environment: `PRX_BEADS_VM` selects the
 * Lima VM daemon (`PRX_BEADS_VM_SOCKET` overrides its in-VM socket); otherwise a
 * local socket (`PRX_BEADS_SOCKET` overrides the default).
 */
export function resolveBeadsEndpoint(env: typeof getEnv = getEnv): BeadsEndpoint {
  const vm = env("PRX_BEADS_VM");
  if (vm) {
    return { kind: "lima", vm, vmSocket: env("PRX_BEADS_VM_SOCKET") ?? DEFAULT_VM_BEADS_SOCKET };
  }
  return { kind: "local", socket: env("PRX_BEADS_SOCKET") ?? DEFAULT_LOCAL_BEADS_SOCKET };
}

/** Heuristic: did this error come from a connect-time failure (no daemon listening)? */
function isUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOENT|connect|did not appear|forward failed|closed the connection/i.test(msg);
}

export interface WithBeadsClientDeps {
  /** Override the resolved endpoint (default: {@link resolveBeadsEndpoint}). */
  endpoint?: BeadsEndpoint | undefined;
  /** Local transport factory (default {@link unixSocketTransport}); tests inject. */
  localTransport?: ((socket: string) => FramedTransport) | undefined;
  /** Lima channel deps (forwarded to {@link withLimaBeadsClient}); tests inject. */
  lima?: LimaBeadsChannelDeps | undefined;
}

/**
 * Run `fn` with a beads client over the resolved endpoint, then clean up. A
 * connect-time failure becomes a {@link BeadsUnavailableError} with a "start
 * beadsd" message — the "require beadsd up" contract.
 */
export async function withBeadsClient<T>(
  fn: (client: IsolatedBeadsClient) => Promise<T>,
  deps: WithBeadsClientDeps = {},
): Promise<T> {
  const endpoint = deps.endpoint ?? resolveBeadsEndpoint();

  if (endpoint.kind === "lima") {
    try {
      return await withLimaBeadsClient(
        { vm: endpoint.vm, vmSocket: endpoint.vmSocket },
        fn,
        deps.lima ?? {},
      );
    } catch (err) {
      if (isUnreachable(err)) {
        throw new BeadsUnavailableError(
          `beadsd not reachable in VM ${endpoint.vm} — bring it up with ` +
            `\`prx lima up ${endpoint.vm} --daemon beads\` (after \`prx lima provision-beads\`)`,
          err,
        );
      }
      throw err;
    }
  }

  const makeTransport = deps.localTransport ?? unixSocketTransport;
  const client = new IsolatedBeadsClient(makeTransport(endpoint.socket));
  try {
    return await fn(client);
  } catch (err) {
    if (isUnreachable(err)) {
      throw new BeadsUnavailableError(
        `beadsd not reachable at ${endpoint.socket} — start it with ` +
          `\`prx beads serve --socket ${endpoint.socket} --cwd <repo>\` (or set PRX_BEADS_VM)`,
        err,
      );
    }
    throw err;
  }
}
