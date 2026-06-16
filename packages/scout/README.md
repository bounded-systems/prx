# @bounded-systems/scout

Content-addressed surface reads — `file`, `grep`, `files` — with anchored-chain
provenance.

When an agent reads the repository (a file's contents, a grep across it, a
directory listing), scout addresses what it read by content digest and records
the read in the anchored-chain derivation graph. So a later step can prove
*exactly* what bytes a decision was made on, and detect when the surface has
since changed.

## Install

```sh
npm install @bounded-systems/scout @bounded-systems/cas @bounded-systems/anchored-chain @bounded-systems/anchored-chain-sqlite
```

> Pulls in `@bounded-systems/anchored-chain-sqlite`, which is **Bun-only**, so
> scout runs on [Bun](https://bun.sh).

## Usage

```ts
// file / grep / files reads return content addressed by digest, and record the
// read into the anchored-chain store so the surface is provable and its drift
// detectable.
```

## Design

- **Reads are provenance.** Every surface read is content-addressed and anchored,
  so what an agent saw is verifiable after the fact.
- **Builds on the provenance stack.** Depends on `cas` (addressing) and
  `anchored-chain` (+ its SQLite store). An extractability test enforces those
  are the only repo dependencies.

## License

[MIT](./LICENSE) © Bounded Systems
