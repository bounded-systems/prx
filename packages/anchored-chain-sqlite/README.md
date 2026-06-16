# @bounded-systems/anchored-chain-sqlite

The SQLite/Drizzle-backed implementation of the
[`@bounded-systems/anchored-chain`](https://github.com/bounded-systems/anchored-chain)
stores.

The pure core defines the ports (`RefStore`, `DerivationStore`,
`AnchoredChainStore`) but binds to no database. This package is where
`bun:sqlite` + `drizzle-orm` live: it implements those ports over a real
database, runs the bundled migrations, and offers lineage/invalidation queries
against persisted state. Consumers that only need the algorithms or contracts
import the core directly and never pull a database dependency.

> **Bun-only.** This package uses `bun:sqlite` and `drizzle-orm/bun-sqlite`, so
> it runs on [Bun](https://bun.sh), not Node. The published `exports` resolve to
> the TypeScript source under the `bun` condition; `dist` carries type
> declarations only.

## Install

```sh
bun add @bounded-systems/anchored-chain-sqlite
```

`@bounded-systems/anchored-chain`, `@bounded-systems/cas`, and `drizzle-orm` come
along as dependencies.

## Usage

```ts
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";

// Open (and migrate) a store. The whole core surface is re-exported here, so a
// store consumer needs only this one import.
const chain = openAnchoredChain({ path: "./provenance.db" });

const ref = await chain.putDerivation(derivation);
const stale = await chain.isStale(ref);
```

The migrations under `src/migrations/` are bundled with the package and applied
on open, so a fresh database is brought to the current schema automatically.

## Design

- **Database lives here, not in the core.** Keeping `bun:sqlite` + `drizzle-orm`
  in this package lets the pure `anchored-chain` core stay dependency-light and
  database-free.
- **Migrations travel with the code.** The drizzle journal + `.sql` files ship in
  the package and run on open, so the schema is self-describing.
- **Self-contained.** An extractability test enforces that the only outbound
  imports are the core, the CAS substrate, drizzle, and Bun/node builtins.

## License

[MIT](./LICENSE) © Bounded Systems
