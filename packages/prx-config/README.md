# @bounded-systems/prx-config

A parser/emitter for the prx TUI configuration schema, covering the L1 (Claude)
and L2 (Warp) tool surfaces.

It parses a tool's config into a typed subset, emits that subset back out, and
reports drift between what's on disk and what prx expects — so the two tool
layers stay in sync against one schema.

## Install

```sh
npm install @bounded-systems/prx-config zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
import {
  parse,
  emit,
  driftReport,
  parseFile,
  emitToFile,
  TuiSubsetSchema,
  // L2 / Warp variants are exported with a `…Warp` suffix:
  parseWarp,
  emitWarp,
  TuiL2WarpSchema,
} from "@bounded-systems/prx-config";

const cfg = parse(rawL1Claude);          // typed TuiSubset
const text = emit(cfg);                   // back to config text
const drift = driftReport(onDisk, cfg);   // what differs
```

`parseFile` / `emitToFile` are the filesystem-backed conveniences; the rest are
pure transforms over in-memory config.

## Design

- **One schema, two surfaces.** L1 (Claude) and L2 (Warp) project from a shared
  Zod schema, so drift between them is detectable rather than silent.
- **Leaf package.** Its only dependencies are the `zod` peer dep and `node:fs`
  (for the `*File` helpers); an extractability test enforces no upward edges and
  no other ambient authority.

## License

[MIT](./LICENSE) © Bounded Systems
