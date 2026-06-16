# @bounded-systems/git

A wrapper around the `git` CLI with policy enforcement and stale-lock recovery.

Git invocations route through here so subcommands are policy-checked before they
run, and a stale `index.lock` left by a crashed process is detected and
recovered rather than wedging the repo.

## Install

```sh
npm install @bounded-systems/git @bounded-systems/env @bounded-systems/proc @bounded-systems/policy @bounded-systems/fs
```

## Usage

```ts
// Policy-checked git operations; a stale index.lock from a dead process is
// recovered instead of failing the command.
```

## Design

- **Policy-gated.** Subcommands go through `@bounded-systems/policy` before the
  process is spawned (`@bounded-systems/proc`).
- **Stale-lock recovery.** Detects an `index.lock` with no owning process and
  clears it (using `@bounded-systems/fs`), so a prior crash doesn't block work.
  An extractability test enforces the dependency set (`env`, `proc`, `policy`,
  `fs`).

## License

[MIT](./LICENSE) © Bounded Systems
