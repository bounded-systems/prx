import type { Digest } from "./types.ts";

export interface InvalidationCapable {
  readonly invalidate: { descendants(movedDigest: Digest): Promise<Digest[]> };
}

export async function descendants(
  store: InvalidationCapable,
  movedDigest: Digest,
): Promise<Digest[]> {
  return store.invalidate.descendants(movedDigest);
}
