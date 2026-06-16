# @bounded-systems/bd

A typed interface to the [beads](https://github.com/steveyegge/beads) (`bd`) CLI,
with policy enforcement and short-ID guards.

Rather than shell out to `bd` ad hoc, callers use typed operations whose inputs
and outputs are schema-validated. Subcommands are policy-gated, and short-ID
guards catch the ambiguous-id footguns the raw CLI allows.

## Install

```sh
npm install @bounded-systems/bd @bounded-systems/env @bounded-systems/proc @bounded-systems/policy zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
// Typed bd operations (create / show / list / update / close …) with
// schema-validated I/O, policy-gated subcommands, and short-ID guards.
```

## Design

- **Typed over the CLI.** Operations validate I/O with Zod instead of passing raw
  strings, so callers get types and the parsing lives in one place.
- **Policy-gated, guarded.** Subcommands go through `@bounded-systems/policy`;
  short-ID guards reject ambiguous ids. Spawns via `@bounded-systems/proc`. An
  extractability test enforces the dependency set (`env`, `proc`, `policy`).

## License

[MIT](./LICENSE) © Bounded Systems
