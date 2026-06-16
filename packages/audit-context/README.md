# @bounded-systems/audit-context

Ambient runtime context for audit attribution — the verb, actor, and truth
reason a privileged call should be recorded under.

When a `gh` (or similar) call is made deep in a call stack, the audit log wants
to know *why*: which verb invoked it, on whose behalf, and on what basis it was
trusted. Threading that through every signature is noise, so this package holds
it as a scoped ambient context that the call site reads at the moment of the
call.

## Install

```sh
npm install @bounded-systems/audit-context
```

## Usage

```ts
import {
  withGhTruthReason,
  getAuditRuntimeContext,
  setAuditRuntimeContext,
  type GhTruthReason,
} from "@bounded-systems/audit-context";

// Establish attribution for the dynamic extent of a call.
await withGhTruthReason("verified-owner", async () => {
  // any gh call in here reads the context for its audit record
  const ctx = getAuditRuntimeContext();
});
```

`setAuditRuntimeContext` sets the ambient verb/actor; `withGhTruthReason` scopes
a truth reason to a callback and restores the prior value after.

## Design

- **Scoped, not global-forever.** Context is set for a bounded extent and
  restored, so attribution can't leak between unrelated operations.
- **Leaf package.** No repo dependencies and no other ambient authority — an
  extractability test enforces it.

## License

[MIT](./LICENSE) © Bounded Systems
