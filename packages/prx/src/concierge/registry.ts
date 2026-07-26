/**
 * The concierge provider registry (prx-8uf2 / prx-9s14) — the in-memory state
 * the `concierged` daemon holds: which boxes serve which capability, each lease
 * expiring unless re-registered. Pure + injectable-clock so it's testable
 * without a socket; the daemon (`./daemon.ts`) wraps it with the wire methods.
 *
 * Matches door-kit's published concierge client contract (`lib/concierge.ts`):
 * a provider `register`s a capability on a door socket with a lease TTL; a
 * consumer `resolve`s the capability and the daemon mints a signed grant for a
 * LIVE provider; `list` reports what is currently served.
 */

/** Default provider-lease TTL (seconds) — how long a registration stays
 *  discoverable before the provider must re-register. Distinct from the minted
 *  GRANT's exp (short, per-lease); this only governs registry discoverability. */
export const DEFAULT_PROVIDER_LEASE_SECONDS = 3600;

/** A registered provider of a capability, with its lease expiry (epoch ms). */
export interface ProviderEntry {
  readonly capability: string;
  /** Socket path (or `host:port`) the provider serves the capability on. */
  readonly door: string;
  /** Env var the consumer binds the door to (default `<CAP>_SOCK`). */
  readonly env: string;
  /** One-line capability description for the rulebook. */
  readonly grants: string;
  /** Ceiling caveats — the most authority this provider will ever hand out. */
  readonly caveats: readonly string[];
  /** Lease expiry, epoch ms — past this the entry is not `live`. */
  readonly expiresAt: number;
}

/** Input to {@link ProviderRegistry.register} (the wire `register` params). */
export interface RegisterInput {
  readonly capability: string;
  readonly door: string;
  readonly env?: string;
  readonly grants?: string;
  readonly caveats?: readonly string[];
  /** Lease TTL in seconds (default {@link DEFAULT_PROVIDER_LEASE_SECONDS}). */
  readonly lease?: number;
}

/** A discovery row: a capability + how many live providers serve it. */
export interface CapabilityRow {
  readonly capability: string;
  readonly grants: string;
  readonly providers: number;
}

/**
 * A mutable registry of capability providers. A `(capability, door)` pair is a
 * single slot — re-registering it refreshes the lease (so a provider stays
 * discoverable by re-registering before expiry). Reads filter by liveness
 * against an injected `now`, so an expired lease silently drops out.
 */
export class ProviderRegistry {
  private readonly slots = new Map<string, ProviderEntry>();

  private static key(capability: string, door: string): string {
    // A newline can't appear in a capability id, so it's an unambiguous separator.
    return `${capability}\n${door}`;
  }

  /** Register (or refresh) a provider; returns the granted lease TTL (seconds). */
  register(input: RegisterInput, now: number): { ttl: number } {
    const ttl = input.lease ?? DEFAULT_PROVIDER_LEASE_SECONDS;
    const entry: ProviderEntry = {
      capability: input.capability,
      door: input.door,
      env: input.env ?? `${input.capability.toUpperCase()}_SOCK`,
      grants: input.grants ?? `the ${input.capability} capability`,
      caveats: input.caveats ? [...input.caveats] : [],
      expiresAt: now + ttl * 1000,
    };
    this.slots.set(ProviderRegistry.key(input.capability, input.door), entry);
    return { ttl };
  }

  /** Live (unexpired) providers for a capability, in registration order. */
  live(capability: string, now: number): ProviderEntry[] {
    return [...this.slots.values()].filter((e) => e.capability === capability && e.expiresAt > now);
  }

  /** Discovery: one row per capability with at least one live provider. */
  list(now: number): CapabilityRow[] {
    const byCapability = new Map<string, { grants: string; providers: number }>();
    for (const e of this.slots.values()) {
      if (e.expiresAt <= now) continue;
      const row = byCapability.get(e.capability);
      if (row) row.providers += 1;
      else byCapability.set(e.capability, { grants: e.grants, providers: 1 });
    }
    return [...byCapability.entries()].map(([capability, r]) => ({
      capability,
      grants: r.grants,
      providers: r.providers,
    }));
  }
}
