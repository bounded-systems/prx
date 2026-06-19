import type { DerivationStore } from "./derivation-store.ts";
import type { RefStore } from "./ref-store.ts";
import type { Digest } from "./types.ts";

/**
 * The composed store port: refs + derivations plus the lineage/invalidation
 * queries over them. This is the *interface* — the shape a backend satisfies.
 * The SQLite/Drizzle implementation (`openAnchoredChain`) lives in
 * @bounded-systems/anchored-chain-sqlite, so the pure core (and its consumers, like the
 * merge guards) depend on this port, not on a database.
 */
export interface AnchoredChainStore {
  readonly refs: RefStore;
  readonly derivations: DerivationStore;
  readonly invalidate: { descendants(movedDigest: Digest): Promise<Digest[]> };
  readonly lineage: {
    ancestors(derivationId: Digest): Promise<Digest[]>;
    descendants(derivationId: Digest): Promise<Digest[]>;
    isStale(derivationId: Digest, currentRefs: Readonly<Record<string, Digest>>): Promise<boolean>;
  };
  close(): void;
}
