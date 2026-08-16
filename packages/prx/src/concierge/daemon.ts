/**
 * concierged — the concierge daemon (prx-8uf2 / prx-9s14): the grant SOURCE the
 * door-gate system was missing. It holds the provider registry + the door
 * authority's signing key and serves four methods over the guest-room protocol
 * (the exact contract door-kit's published `lib/concierge.ts` client dials):
 *
 *   register {capability, door, env?, grants?, caveats?, lease?} → {ttl}
 *   resolve  {capability, want, audience}                        → {door: SignedGrant}
 *   keys                                                         → IssuerKeys
 *   list                                                         → {capabilities}
 *
 * `resolve` mints a short-lived, audience/exp/nonce-bound grant for a LIVE
 * provider (attenuated by `want`), signed by the door authority — reusing the
 * issuer (`src/door/grant-issuer.ts`) and guest-room `signGrant`. A serving
 * room's `signedGrantAuthorizer` (keeperd #833 / ghappd #844), configured with
 * this concierge's `keys`, then verifies it. Closes the loop:
 * resolve → present → verify.
 *
 * concierged itself is reached over the in-pod UNIX fabric, where the kernel-
 * authenticated peer is the authority (held-ref; CONCIERGE.md §7) — so it does
 * NOT gate its own edge. The audience a caller claims is trusted on that fabric.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants as FS, existsSync, openSync, rmSync, writeSync } from "node:fs";

import {
  attenuate,
  signGrant,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
  type SignedGrant,
} from "@bounded-systems/guest-room";
import { createDoorHandlers } from "@bounded-systems/guest-room/protocol";

import { listenTarget } from "../door/listen-target.ts";
import {
  DEFAULT_GRANT_ISSUER_ACTOR,
  issuerKeys as defaultIssuerKeys,
  resolveGrantIssuer,
  type GrantIssuer,
} from "../door/grant-issuer.ts";
import { ProviderRegistry, type CapabilityRow, type RegisterInput } from "./registry.ts";

/** Default minted-grant lifetime (seconds) — SHORT (per-lease), mirroring token TTLs. */
export const DEFAULT_GRANT_TTL_SECONDS = 60;

export interface ConciergeDaemonDeps {
  /** The registry (defaults to a fresh one). */
  readonly registry?: ProviderRegistry;
  /** The door-authority signing identity (defaults to the keymaker per-actor key). */
  readonly issuer?: GrantIssuer;
  /** Published issuer keys for the `keys` method (defaults to {@link defaultIssuerKeys}). */
  readonly issuerKeys?: () => IssuerKeys;
  /** Clock, epoch ms (injected for tests). */
  readonly now?: () => number;
  /** Freshness nonce per minted grant (injected for tests). */
  readonly nonce?: () => string;
  /** Minted-grant lifetime in seconds (default {@link DEFAULT_GRANT_TTL_SECONDS}). */
  readonly grantTtlSeconds?: number;
}

/** A failed resolve: no live provider serves the capability. */
function noProvider(capability: string): never {
  throw new Error(`no live provider for capability '${capability}'`);
}

/**
 * Mint a signed grant for a live provider of `capability`, bound to `audience`
 * and attenuated by `want` (narrower-only — appended to the provider's ceiling).
 * The grant's `name` is the capability (== the serving door's name), so the
 * serving room's `signedGrantAuthorizer(door: capability)` matches it.
 */
function mintForProvider(args: {
  capability: string;
  want: readonly string[];
  audience: string;
  registry: ProviderRegistry;
  issuer: GrantIssuer;
  now: number;
  nonce: string;
  grantTtlSeconds: number;
}): SignedGrant {
  const [provider] = args.registry.live(args.capability, args.now);
  if (!provider) noProvider(args.capability);
  const base: DoorGrant = {
    name: args.capability,
    host: unix(provider.door),
    guest: unix(provider.door),
    env: provider.env,
    grants: provider.grants,
    use: `present this grant to the ${args.capability} door`,
    ...(provider.caveats.length ? { caveats: [...provider.caveats] } : {}),
  };
  // Narrower-only: append the consumer's `want` to the provider's ceiling.
  const grant = args.want.length ? attenuate(base, [...args.want]) : base;
  const binding: GrantBinding = {
    audience: args.audience,
    exp: args.now + args.grantTtlSeconds * 1000,
    nonce: args.nonce,
    keyId: args.issuer.kid,
  };
  return signGrant(grant, binding, args.issuer.sign);
}

export interface ConciergeServeOptions {
  /** Endpoint the daemon listens on — a unix socket path (the in-pod fabric). */
  socketPath: string;
  /** When set, the daemon records its pid here once listening (removed on close). */
  pidfile?: string | undefined;
  deps?: ConciergeDaemonDeps | undefined;
  /** Structured log sink (level, message). Defaults to `console.error`. */
  log?: ((level: string, msg: string) => void) | undefined;
}

/** A handle on the running concierge daemon: stop it, or await its close. */
export interface ConciergeServer {
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

/**
 * Bind the concierge daemon over the guest-room protocol. Resolves with a
 * {@link ConciergeServer} (close it to stop). Reuses the keymaker per-actor key
 * (the door authority) to sign resolved grants; `keys` publishes its public half.
 */
export function runConciergeServe(options: ConciergeServeOptions): Promise<ConciergeServer> {
  const { socketPath, pidfile } = options;
  const deps = options.deps ?? {};
  const registry = deps.registry ?? new ProviderRegistry();
  const issuer = deps.issuer ?? resolveGrantIssuer(DEFAULT_GRANT_ISSUER_ACTOR);
  const issuerKeysFn = deps.issuerKeys ?? (() => defaultIssuerKeys(DEFAULT_GRANT_ISSUER_ACTOR));
  const now = deps.now ?? (() => Date.now());
  const nonce = deps.nonce ?? (() => randomUUID());
  const grantTtlSeconds = deps.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  const log =
    options.log ?? ((level: string, msg: string) => console.error(`concierged ${level}: ${msg}`));

  const handlers = createDoorHandlers(
    "concierge",
    {
      register: (params) => {
        const input = params as unknown as RegisterInput;
        if (!input.capability || !input.door) {
          throw new Error("register requires { capability, door }");
        }
        return registry.register(input, now());
      },
      resolve: (params) => {
        const p = params as { capability?: string; want?: string[]; audience?: string };
        if (!p.capability) throw new Error("resolve requires { capability }");
        const door = mintForProvider({
          capability: p.capability,
          want: p.want ?? [],
          audience: p.audience ?? "",
          registry,
          issuer,
          now: now(),
          nonce: nonce(),
          grantTtlSeconds,
        });
        return { door };
      },
      keys: () => issuerKeysFn(),
      list: (): { capabilities: CapabilityRow[] } => ({ capabilities: registry.list(now()) }),
    },
    (level, msg) => log(level, msg),
  );

  const target = listenTarget(socketPath);
  if ("unix" in target && existsSync(target.unix)) rmSync(target.unix, { force: true });
  const listener =
    "unix" in target
      ? Bun.listen({ unix: target.unix, socket: handlers })
      : Bun.listen({ hostname: target.hostname, port: target.port, socket: handlers });
  if (pidfile !== undefined) {
    const fd = openSync(pidfile, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
  }
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const server: ConciergeServer = {
    async close() {
      listener.stop(true);
      if ("unix" in target) rmSync(target.unix, { force: true });
      if (pidfile !== undefined) rmSync(pidfile, { force: true });
      resolveClosed();
    },
    closed,
  };
  return Promise.resolve(server);
}
