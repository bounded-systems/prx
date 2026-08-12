---
---

Pin every direct dependency exactly, and gate floating ranges in CI (GH-1039).

No release: this is a manifest + tooling change. Each of the 38 pinned specs was
set to the version `bun.lock` had **already** resolved, so no dependency moves —
verified by diffing the lockfile's `packages` section before and after (identical:
no additions, removals, or changed resolutions). Only the lockfile's manifest
mirror changed, to record the exact specs.

- Sweep: `dependencies` / `devDependencies` / `optionalDependencies` in the root
  and both `packages/*` manifests now carry exact versions.
  `peerDependencies` are deliberately untouched — a peer range is a compatibility
  statement to consumers, and pinning one is a different, breaking decision.
- Gate: `bun run deps:pins:check` (`packages/prx/scripts/check-dep-pins.ts`),
  wired into `ci`, fails on `^ ~ * x latest` and on git refs that are not a
  40-hex commit SHA. Its escape hatch, `.dep-pins-allowlist.json`, is a
  *shrinking* allowlist: an entry needs a written reason, and a stale entry fails
  the gate, so the list can only drain.
