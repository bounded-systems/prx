# @bounded-systems/disposition

A pure classifier that maps a work unit's surface state to a **disposition**:
`ok`, `prune`, `repair`, or `review`.

Given the observable state of a work unit (its PR, branch, checks, …), this
answers a single question — what should happen to it next? — as a total,
side-effect-free function. The disposition is the input to whatever actor or
pipeline acts on it.

## Install

```sh
npm install @bounded-systems/disposition zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
import { classify, dispositionSchema, type Disposition } from "@bounded-systems/disposition";

const d: Disposition = classify(input); // "ok" | "prune" | "repair" | "review"

// The schema is exported for validating/serializing the result at a boundary.
dispositionSchema.parse(d);
```

## Design

- **Pure and total.** `classify` is a deterministic function of its input — no
  I/O, no clock, no ambient state — so it's trivially testable and replayable.
- **Leaf package.** Its only dependency is the `zod` peer dep; an extractability
  test enforces no upward edges and no ambient authority.

## License

[MIT](./LICENSE) © Bounded Systems
