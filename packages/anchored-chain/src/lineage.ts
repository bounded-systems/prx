import type { Digest } from './types.ts';

export interface LineageCapable {
  readonly lineage: {
    ancestors(derivationId: Digest): Promise<Digest[]>;
    descendants(derivationId: Digest): Promise<Digest[]>;
    isStale(
      derivationId: Digest,
      currentRefs: Readonly<Record<string, Digest>>,
    ): Promise<boolean>;
  };
}

export async function ancestors(
  store: LineageCapable,
  derivationId: Digest,
): Promise<Digest[]> {
  return store.lineage.ancestors(derivationId);
}

export async function descendants(
  store: LineageCapable,
  derivationId: Digest,
): Promise<Digest[]> {
  return store.lineage.descendants(derivationId);
}

export async function isStale(
  store: LineageCapable,
  derivationId: Digest,
  currentRefs: Readonly<Record<string, Digest>>,
): Promise<boolean> {
  return store.lineage.isStale(derivationId, currentRefs);
}
