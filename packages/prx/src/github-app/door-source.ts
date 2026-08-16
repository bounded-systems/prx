// The broker's DOOR token source: lease a short-lived installation token from
// forge-d instead of minting locally from a held PEM. This is the cloud-native
// posture — the agent holds no App key, only a reference to the door (the
// `PRX_FORGE_DOOR` endpoint), and asks forge-d to mint. Shares the broker cache
// (`cachingBroker`) so a burst of GitHub ops triggers at most one lease.
import { call } from "@bounded-systems/guest-room/protocol";

import { IsolatedForgeDClient, type ForgeDTransport } from "../forge-d/client.ts";
import { type GrantProvider } from "../door/grant-provider.ts";
import { type Broker, type BrokeredToken, cachingBroker } from "./broker.ts";

export interface DoorBrokerOptions {
  /** The forge-d door endpoint (`unix:///path` or `host:port`) — PRX_FORGE_DOOR. */
  readonly endpoint: string;
  /** Optional client-requested attenuation (the door floors what it will grant). */
  readonly repositories?: readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  /** Injected transport (tests); defaults to a guest-room `call` to the endpoint. */
  readonly transport?: ForgeDTransport;
  /**
   * Optional signed-grant provider. On a TCP/cross-host forge-d a reachable
   * socket is not authority, so the lease must present a grant (the door's
   * `signedGrantAuthorizer` verifies it); the provider refreshes it before TTL.
   * Omitted ⇒ no grant presented (a unix door, where the held reference is the
   * authority).
   */
  readonly grantProvider?: GrantProvider;
  readonly now?: () => number;
  readonly refreshMarginMs?: number;
}

/**
 * The default forge-d transport: speak the guest-room door protocol — `call` the
 * `lease` method at the endpoint with the request's attenuation as params (the
 * `kind` discriminator is now carried by the method name, not the body). When a
 * `grantProvider` is given, a live signed grant rides in the call (TCP doors). A
 * gate-denied / malformed reply rejects (fail-closed); a `status: "error"` lease
 * is a normal resolved reply (data, not an exception).
 */
function forgeDCallTransport(endpoint: string, grantProvider?: GrantProvider): ForgeDTransport {
  return async (request) => {
    const params = {
      ...(request.repositories ? { repositories: request.repositories } : {}),
      ...(request.permissions ? { permissions: request.permissions } : {}),
    };
    const grant = grantProvider ? await grantProvider.current() : undefined;
    return call(endpoint, "lease", params, grant ? { grant } : {});
  };
}

/**
 * A broker that leases from forge-d over the door transport. The lease reply's
 * `expiresAt` (ISO) becomes the cache expiry; a `status: "error"` reply throws
 * (fail-closed — there is no local PEM fallback on the door path).
 */
export function createDoorBroker(options: DoorBrokerOptions): Broker {
  const transport =
    options.transport ?? forgeDCallTransport(options.endpoint, options.grantProvider);
  const client = new IsolatedForgeDClient((request) => transport(request));

  const fetchToken = async (): Promise<BrokeredToken> => {
    const reply = await client.lease({
      kind: "lease",
      ...(options.repositories ? { repositories: [...options.repositories] } : {}),
      ...(options.permissions ? { permissions: { ...options.permissions } } : {}),
    });
    if (reply.status === "error") {
      throw new Error(`forge-d lease failed (${reply.code}): ${reply.message}`);
    }
    return {
      token: reply.token,
      expiresAt: Date.parse(reply.expiresAt),
      permissions: reply.permissions,
    };
  };

  return cachingBroker(fetchToken, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.refreshMarginMs !== undefined ? { refreshMarginMs: options.refreshMarginMs } : {}),
  });
}
