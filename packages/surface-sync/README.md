# @bounded-systems/surface-sync

The type ontology for work-unit change-detection — the shared vocabulary for
reconciling a unit's state across GitHub, the branch, the worktree, tmux, and
beads.

This package is mostly types: the surfaces a work unit presents on, the shape of
a detected change, how changes route and transform, and how they reduce to a
result. It builds on `@bounded-systems/disposition` for the ok/prune/repair/review
verdict a reconciled surface maps to.

## Install

```sh
npm install @bounded-systems/surface-sync @bounded-systems/disposition
```

## Usage

```ts
import type {
  // surface — the places a unit shows up (GH / branch / worktree / tmux / beads)
  // action, routing, transform — how a detected change is classified and applied
  // result, snapshot, scope — the reconciliation outputs
} from "@bounded-systems/surface-sync";
```

The barrel re-exports the `surface`, `action`, `routing`, `transform`, `result`,
`snapshot`, `scope`, `config`, and `format` modules — import the types and
helpers for the surface you're reconciling.

## Design

- **Ontology, not engine.** This defines the shared types for change-detection;
  the actors that read the surfaces and apply changes depend on it.
- **Builds on `@bounded-systems/disposition`.** A reconciled surface maps to a
  disposition. An extractability test enforces that `disposition` is the only
  repo dependency and there's no ambient authority.

## License

[MIT](./LICENSE) © Bounded Systems
