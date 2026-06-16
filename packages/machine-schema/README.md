# @bounded-systems/machine-schema

Schema primitives for work-unit state machines: branded types, the handoff
envelope, and the state / phase / invariant building blocks.

This is the shared vocabulary the machines are written against — branded
identifiers that can't be confused with bare strings, the envelope one machine
hands to the next, and the Zod schemas for states, phases, and invariants.

## Install

```sh
npm install @bounded-systems/machine-schema zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
import {
  // brands — nominal types over primitives
  // handoff — the envelope passed between machines
  // state — state/phase/invariant schemas
} from "@bounded-systems/machine-schema";
```

The barrel re-exports the `brands`, `handoff`, and `state` modules; import the
brand constructors, the handoff envelope schema, and the state primitives you
need.

## Design

- **Brands over strings.** Identifiers are nominal, so a work-unit id can't be
  passed where a contract id is expected.
- **Leaf package.** Its only dependency is the `zod` peer dep; an extractability
  test enforces no upward edges and no ambient authority.

## License

[MIT](./LICENSE) © Bounded Systems
