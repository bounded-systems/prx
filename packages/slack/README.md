# @bounded-systems/slack

A policy-gated, provenance-tracked Slack **read** surface — bounded read
operations behind a swappable transport, authorized by keymaker-minted scoped
credentials.

Slack access here is read-only and narrow: a small set of read ops sit behind a
transport port (so the real Slack client can be swapped for a fake in tests),
each call is policy-gated, the credentials are short-lived and scoped, and the
reads are recorded with anchored-chain provenance.

## Install

```sh
npm install @bounded-systems/slack
```

Brings its capability dependencies along: `anchored-chain` (+ the Bun-only
SQLite store), `auth`, `cas`, `env`, `policy`, and `proc`. Runs on
[Bun](https://bun.sh).

## Usage

```ts
// Bounded, policy-gated read ops (e.g. fetch a channel's recent messages)
// behind a swappable transport; credentials are minted scoped per read and the
// reads are anchored for provenance.
```

## Design

- **Read-only and bounded.** A small, fixed set of read operations — no write
  surface — each gated by `@bounded-systems/policy`.
- **Scoped credentials, provenance-tracked.** Credentials are minted per read
  (`auth`) and reads are anchored (`anchored-chain` + store). An extractability
  test enforces the dependency set.

## License

[MIT](./LICENSE) © Bounded Systems
