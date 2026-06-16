# @bounded-systems/anchored-chain

A derivation chain with contract validation, signing, lineage tracking, and
invalidation — the pure provenance core.

Built directly on the content-addressable substrate
([`@bounded-systems/cas`](https://github.com/bounded-systems/cas)): every
derivation is addressed by the digest of its canonical manifest, signed as an
[in-toto](https://in-toto.io/) statement wrapped in a DSSE envelope, and linked
to its inputs so lineage (ancestors/descendants) and invalidation propagate
along the graph. The core is storage-agnostic — it depends only on `node:crypto`
(Ed25519 signing) and the `cas` substrate; the SQLite/Drizzle-backed store lives
separately in
[`@bounded-systems/anchored-chain-sqlite`](https://github.com/bounded-systems/anchored-chain-sqlite).

## Install

```sh
npm install @bounded-systems/anchored-chain @bounded-systems/cas
```

## Usage

```ts
import {
  digestManifest,
  manifestToStatement,
  assembleEnvelope,
  generateEd25519Keypair,
  ed25519Signer,
  ed25519Verifier,
  validateDerivation,
} from "@bounded-systems/anchored-chain";

// A derivation is content-addressed by its canonical manifest digest.
const ref = digestManifest(manifest);

// Sign it as an in-toto statement inside a DSSE envelope.
const keypair = generateEd25519Keypair();
const statement = manifestToStatement(manifest);
const envelope = await assembleEnvelope(statement, ed25519Signer(keypair));

// Verify against a store-backed capability.
const verdict = await validateDerivation(derivation, {
  verifier: ed25519Verifier(keypair.publicKey),
});
```

`Applier`, `Fetcher`, `ContractRegistry`, `RefStore`, `DerivationStore`, and
`AnchoredChainStore` are the ports the core depends on; a concrete store (e.g.
the SQLite package) implements them, so the core never binds to a database.

## Design

- **Pure core, no ambient authority.** Production code touches `node:crypto` and
  the `cas` substrate only — no database, no filesystem, no subprocess, no
  `process.env`. An extractability test enforces this.
- **Content-addressed lineage.** A ref is the digest of its manifest; lineage
  and invalidation are graph walks over input/output edges.
- **Standard provenance shapes.** Manifests project to in-toto statements and
  DSSE envelopes, so a derivation is verifiable by off-the-shelf tooling.

## License

[MIT](./LICENSE) © Bounded Systems
