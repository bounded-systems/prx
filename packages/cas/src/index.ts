/**
 * Content-addressable storage — the substrate.
 *
 * The lowest layer in the provenance stack: bytes addressed by their SHA-256
 * digest. Anchored-chain (derivation/provenance graph) and scout (content-
 * addressed surface reads) both build on this; neither owns it. A standalone
 * concern by the litmus in docs/architecture/standalone-modules.md — today an
 * in-repo module, on a path to its own package, with the store eventually a
 * wrapped service (local impl now, OCI-registry-backed impl later, same port).
 */

export type { Digest } from "./digest.ts";
export { sha256BareHex, sha256Hex } from "./digest.ts";

export type { BlobStore } from "./blob-store.ts";
