// Per-process GitHub App token broker: wraps the pure mintInstallationToken
// primitive with a cache + expiry-aware refresh + concurrency dedupe, so a burst
// of GitHub ops triggers at most one HTTP mint. Pure over injected deps; never
// logs the token.
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

export interface BrokerDeps {
  /** The minting primitive; injected for tests. */
  readonly mint?: typeof mintInstallationToken;
  /** Injected clock (ms) for cache freshness + the JWT. */
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly refreshMarginMs?: number;
}

export interface Broker {
  /** Return a fresh token, minting (once, deduped) when missing or near expiry. */
  ensure(): Promise<BrokeredToken>;
  /** Sync cache read with no mint — diagnostics only. */
  peek(): BrokeredToken | null;
  /** Drop the cache (test hook). */
  reset(): void;
}

export function createBroker(config: BrokerConfig, deps: BrokerDeps = {}): Broker {
  const mint = deps.mint ?? mintInstallationToken;
  const now = deps.now ?? Date.now;
  const margin = deps.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;

  let cached: BrokeredToken | null = null;
  let inFlight: Promise<BrokeredToken> | null = null;

  const isFresh = (t: BrokeredToken): boolean => now() < t.expiresAt - margin;

  const mintDeps = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
  };

  async function doMint(): Promise<BrokeredToken> {
    const res = await mint(
      {
        issuer: config.issuer,
        privateKeyPem: config.privateKeyPem,
        installationId: config.installationId,
      },
      mintDeps,
    );
    const token: BrokeredToken = {
      token: res.token,
      expiresAt: Date.parse(res.expiresAt),
      permissions: res.permissions,
    };
    cached = token; // only set on success → a rejection never poisons the cache
    return token;
  }

  return {
    async ensure() {
      if (cached && isFresh(cached)) return cached;
      if (inFlight) return inFlight; // dedupe concurrent callers to one mint
      inFlight = doMint().finally(() => {
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
