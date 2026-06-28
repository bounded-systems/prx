// Per-process GitHub App token broker: a cache + expiry-aware refresh +
// concurrency dedupe wrapped around a token source, so a burst of GitHub ops
// triggers at most one fetch. Two sources share the cache: `createBroker` mints
// locally from a held PEM (`./installation-token`); `createDoorBroker`
// (`./door-source`) leases from ghappd. Pure over injected deps; never logs.
import { mintInstallationToken } from "./installation-token.ts";
import type { BrokerConfig } from "./broker-config.ts";

/** Default re-mint margin: refresh when within 5 min of the ~1h expiry. */
const DEFAULT_REFRESH_MARGIN_MS = 300_000;

/** A cached installation token with expiry as epoch ms. `token` is secret. */
export interface BrokeredToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly permissions: Readonly<Record<string, string>>;
}

export interface Broker {
  /** Return a fresh token, fetching (once, deduped) when missing or near expiry. */
  ensure(): Promise<BrokeredToken>;
  /** Sync cache read with no fetch — diagnostics only. */
  peek(): BrokeredToken | null;
  /** Drop the cache (test hook). */
  reset(): void;
}

export interface CachingBrokerOptions {
  /** Injected clock (ms) for cache freshness. */
  readonly now?: () => number;
  readonly refreshMarginMs?: number;
}

/**
 * Wrap a `fetchToken` strategy with the broker cache: serve a fresh cached token,
 * re-fetch when missing or within the refresh margin of expiry, and dedupe
 * concurrent callers to a single in-flight fetch. A rejected fetch never poisons
 * the cache (only a success is stored), so the next `ensure()` retries.
 */
export function cachingBroker(
  fetchToken: () => Promise<BrokeredToken>,
  options: CachingBrokerOptions = {},
): Broker {
  const now = options.now ?? Date.now;
  const margin = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;

  let cached: BrokeredToken | null = null;
  let inFlight: Promise<BrokeredToken> | null = null;

  const isFresh = (t: BrokeredToken): boolean => now() < t.expiresAt - margin;

  return {
    async ensure() {
      if (cached && isFresh(cached)) return cached;
      if (inFlight) return inFlight; // dedupe concurrent callers to one fetch
      inFlight = fetchToken()
        .then((t) => {
          cached = t; // only set on success → a rejection never poisons the cache
          return t;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    peek() {
      return cached;
    },
    reset() {
      cached = null;
      inFlight = null;
    },
  };
}

export interface BrokerDeps {
  /** The minting primitive; injected for tests. */
  readonly mint?: typeof mintInstallationToken;
  /** Injected clock (ms) for cache freshness + the JWT. */
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly refreshMarginMs?: number;
}

/** A broker whose token source is a LOCAL mint from the held App PEM. */
export function createBroker(config: BrokerConfig, deps: BrokerDeps = {}): Broker {
  const mint = deps.mint ?? mintInstallationToken;
  const mintDeps = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
  };
  const fetchToken = async (): Promise<BrokeredToken> => {
    const res = await mint(
      {
        issuer: config.issuer,
        privateKeyPem: config.privateKeyPem,
        installationId: config.installationId,
        // Forward least-privilege attenuation when configured (else full scope).
        ...(config.repositories ? { repositories: config.repositories } : {}),
        ...(config.permissions ? { permissions: config.permissions } : {}),
      },
      mintDeps,
    );
    return {
      token: res.token,
      expiresAt: Date.parse(res.expiresAt),
      permissions: res.permissions,
    };
  };
  return cachingBroker(fetchToken, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.refreshMarginMs !== undefined ? { refreshMarginMs: deps.refreshMarginMs } : {}),
  });
}
