---
---

internal: extract the canonical work-unit-id resolution cluster from cli.ts into
a `pr-state/cli-id.ts` leaf (the ADR's planned Stage-0 `cli-id.ts`) — the
memoized helper state + `ensureCanonicalHelpers` / `resetCanonicalHelpers` /
`parseCanonicalWorkUnitId` / `detectWorkCommandTarget` and friends, shared across
the work / plan / session command families. Pure move (codemod-driven) — no
behavior change. Unblocks migrating those families' verbs without a cli.ts
import cycle. No package change.
