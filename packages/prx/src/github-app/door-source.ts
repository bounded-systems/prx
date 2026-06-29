// The broker's DOOR token source: lease a short-lived installation token from
// ghappd instead of minting locally from a held PEM. This is the cloud-native
// posture — the agent holds no App key, only a reference to the door (the
// `PRX_GH_APP_DOOR` endpoint), and asks ghappd to mint. Shares the broker cache
// (`cachingBroker`) so a burst of GitHub ops triggers at most one lease.
import { call } from "@bounded-systems/guest-room/protocol";

import { IsolatedGhappdClient, type GhappdTransport } from "../ghappd/client.ts";
import { type Broker, type BrokeredToken, cachingBroker } from "./broker.ts";

export interface DoorBrokerOptions {
  /** The ghappd door endpoint (`unix:///path` or `host:port`) — PRX_GH_APP_DOOR. */
  readonly endpoint: string;
  /** Optional client-requested attenuation (the door floors what it will grant). */
  readonly repositories?: readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  /** Injected transport (tests); defaults to a guest-room `call` to the endpoint. */
  readonly transport?: GhappdTransport;
  readonly now?: () => number;
  readonly refreshMarginMs?: number;
}

/**
 * The default ghappd transport: speak the guest-room door protocol — `call` the
 * `lease` method at the endpoint with the request's attenuation as params (the
 * `kind` discriminator is now carried by the method name, not the body). A
 * gate-denied / malformed reply rejects (fail-closed); a `status: "error"` lease
 * is a normal resolved reply (data, not an exception).
 */
function ghappdCallTransport(endpoint: string): GhappdTransport {
  return (request) =>
    call(endpoint, "lease", {
      ...(request.repositories ? { repositories: request.repositories } : {}),
      ...(request.permissions ? { permissions: request.permissions } : {}),
    });
}

/**
 * A broker that leases from ghappd over the door transport. The lease reply's
 * `expiresAt` (ISO) becomes the cache expiry; a `status: "error"` reply throws
 * (fail-closed — there is no local PEM fallback on the door path).
 */
export function createDoorBroker(options: DoorBrokerOptions): Broker {
  const transport = options.transport ?? ghappdCallTransport(options.endpoint);
  const client = new IsolatedGhappdClient((request) => transport(request));

  const fetchToken = async (): Promise<BrokeredToken> => {
    const reply = await client.lease({
      kind: "lease",
      ...(options.repositories ? { repositories: [...options.repositories] } : {}),
      ...(options.permissions ? { permissions: { ...options.permissions } } : {}),
    });
    if (reply.status === "error") {
      throw new Error(`ghappd lease failed (${reply.code}): ${reply.message}`);
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
