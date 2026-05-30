import type { Digest } from "./digest.ts";

/**
 * The CAS port. A blob store is the one capability the substrate exposes:
 * put bytes (and learn their address), get bytes by address, ask whether an
 * address is present. Addresses are {@link Digest}s, so the store is the
 * verifier — `get` can re-hash and reject a corrupt blob.
 *
 * This is the contract both the local on-disk implementation and a future
 * remote backend (an OCI registry wrapped via ORAS) satisfy. Callers depend on
 * the port, never on a concrete store — that's what lets the storage become a
 * wrapped service later without touching consumers (zero-trust: authority
 * lives in the digest, not in which actor produced the bytes).
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<Digest>;
  get(digest: Digest): Promise<Uint8Array>;
  has(digest: Digest): Promise<boolean>;
}
