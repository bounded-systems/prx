import { createHash } from "node:crypto";

/**
 * A content address: the lowercase SHA-256 hex with its algorithm prefix,
 * `sha256:<64 hex>`. Branded so a raw string can't be passed where a verified
 * digest is expected. This is the CAS substrate's native identifier — the same
 * shape in-toto/DSSE statements carry (`{ "sha256": "<hex>" }`) and the shape
 * OCI image-layout uses for `blobs/sha256/<hex>`, so a CAS blob is addressable
 * by, and pushable to, those existing systems without translation.
 */
export type Digest = string & { readonly __brand: "Digest" };

/**
 * Bare lowercase hex of the SHA-256 — no algorithm prefix. The on-the-wire
 * form a content-addressed read (scout) holds; {@link sha256Hex} wraps it as
 * the prefixed {@link Digest}. One hashing implementation, two presentations,
 * so no two callers can disagree on the digest of the same bytes.
 */
export function sha256BareHex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof input === "string" ? input : Buffer.from(input));
  return hash.digest("hex");
}

/**
 * SHA-256 of the input as a prefixed {@link Digest} (`sha256:<64 hex>`) — the
 * CAS substrate's native content address. Wraps {@link sha256BareHex} with the
 * algorithm prefix so the result is type-distinct from a bare hex string and
 * can't be passed where a raw hash is expected.
 */
export function sha256Hex(input: string | Uint8Array): Digest {
  return `sha256:${sha256BareHex(input)}` as Digest;
}
