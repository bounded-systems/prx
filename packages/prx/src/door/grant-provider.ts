/**
 * Client-side grant provider (prx-8uf2) — hold a signed grant, refresh it before
 * TTL, present it on each door call. The companion to the issuer
 * (`grant-issuer.ts`, mints) and the gate (`grant-gate.ts`, verifies): the
 * client HOLDS a short-lived grant and re-acquires before it expires, so a long
 * burst of door calls is covered without ever presenting a stale grant.
 *
 * Mirrors `github-app/broker.cachingBroker` (which does the same for tokens):
 * cache + expiry-aware refresh + concurrency dedupe. The `acquire` source is
 * INJECTED — in production a concierge call (deployment-coupled, prx-9s14); in
 * dev/tests `mintDoorGrant`. So the cache/refresh/present logic is pure and
 * verifiable here, independent of where grants actually come from.
 */
import type { SignedGrant } from "@bounded-systems/guest-room";

/** Acquire a fresh grant — a concierge call in prod, `mintDoorGrant` in tests. */
export type AcquireGrant = () => Promise<SignedGrant> | SignedGrant;

export interface GrantProvider {
  /** A live grant (refreshed when within the margin of `exp`), acquiring as needed. */
  current(): Promise<SignedGrant>;
}

/** Re-acquire when within this many ms of `exp` — a safety margin against clock
 *  skew + in-flight latency, matching the token broker's default. */
export const DEFAULT_GRANT_REFRESH_MARGIN_MS = 30_000;

export interface CachingGrantProviderOptions {
  /** The grant source (concierge / `mintDoorGrant`). */
  readonly acquire: AcquireGrant;
  /** Clock, epoch ms (injected for tests). */
  readonly now?: () => number;
  /** Re-acquire when within this many ms of `exp` (default 30s). */
  readonly refreshMarginMs?: number;
}

/**
 * A {@link GrantProvider} that caches the grant and re-acquires only when it is
 * within `refreshMarginMs` of expiry. Concurrent `current()` callers during a
 * refresh share ONE `acquire` (dedupe); a rejected acquire never poisons the
 * cache (the previous grant, if any, stays until a refresh succeeds).
 */
export function cachingGrantProvider(opts: CachingGrantProviderOptions): GrantProvider {
  const now = opts.now ?? Date.now;
  const margin = opts.refreshMarginMs ?? DEFAULT_GRANT_REFRESH_MARGIN_MS;

  let cached: SignedGrant | null = null;
  let inFlight: Promise<SignedGrant> | null = null;

  const isFresh = (g: SignedGrant): boolean => now() < g.binding.exp - margin;

  return {
    async current() {
      if (cached && isFresh(cached)) return cached;
      if (inFlight) return inFlight; // dedupe concurrent callers to one acquire
      inFlight = Promise.resolve(opts.acquire())
        .then((g) => {
          cached = g; // only set on success → a rejection never poisons the cache
          return g;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
