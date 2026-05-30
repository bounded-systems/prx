# @bounded-systems/cas

Content-addressable storage — the substrate.

The lowest layer in the provenance stack: bytes addressed by their SHA-256
digest. Higher layers (a derivation/provenance graph, content-addressed surface
reads) build on this; none owns it. The digest is the same shape in-toto/DSSE
statements carry (`{ "sha256": "<hex>" }`) and the shape OCI image-layout uses
for `blobs/sha256/<hex>`, so a CAS blob is addressable by, and pushable to,
those systems without translation.

## Install

```sh
npm install @bounded-systems/cas
```

## Usage

```ts
import { sha256Hex, sha256BareHex } from "@bounded-systems/cas";
import type { Digest, BlobStore } from "@bounded-systems/cas";

// Prefixed, branded content address: `sha256:<64 hex>`
const id: Digest = sha256Hex("hello");

// Bare lowercase hex — the on-the-wire form a content-addressed read holds.
const bare: string = sha256BareHex("hello");
```

### The blob-store port

`BlobStore` is the one capability the substrate exposes — `put` bytes (and learn
their address), `get` bytes by address, `has` to ask whether an address is
present. Callers depend on the port, never on a concrete store, so the storage
can become a wrapped service later (a local on-disk impl now, an OCI-registry
backend later) without touching consumers. Addresses are `Digest`s, so the store
is the verifier: `get` can re-hash and reject a corrupt blob.

```ts
import type { BlobStore, Digest } from "@bounded-systems/cas";

declare const store: BlobStore;
const addr: Digest = await store.put(new TextEncoder().encode("payload"));
const bytes: Uint8Array = await store.get(addr);
const present: boolean = await store.has(addr);
```

## Design

- **Zero dependencies.** Production code touches `node:crypto` only; the package
  stands alone in CI. An extractability test enforces outward-only imports and
  no ambient authority (no shelling out, no `process.env`).
- **Zero-trust addressing.** Authority lives in the digest, not in which actor
  produced the bytes.

## License

[MIT](./LICENSE) © Bounded Systems
