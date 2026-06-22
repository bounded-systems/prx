# Handoff — finishing the prx ⇄ bounded.tools seam pipeline

> Status: **prx side complete; site side not started.** The remaining work lives
> in `bounded-systems/site` and needs that repo in a session's scope. This doc is
> the self-contained handoff so any session (or human) can finish it without
> re-discovery.

## What the seam pipeline is

The bounded.tools website renders a "capability seams" grid. Each cell's tagline
is sourced **from prx** — prx is the source of truth. Per package, prx carries:

```jsonc
"bounded": {
  "tagline": "<equal to the package description>",
  "kind": "door" | "room" | "guest"
}
```

`kind` follows the codebase's own paradigm (see the OCI substrate, `RoomSpec` =
occupant + doors + image; a *door* is the sanctioned socket seam to a capability):

- **door (12)** — the single sanctioned crossing point to something *outside* the
  process: `env fs host proc repo-root auth gh git bd slack scout github-budget`
- **room (7)** — the bounded internal substrate: `cas anchored-chain
  anchored-chain-sqlite machine-schema policy surface-sync audit-context`
- **guest (4)** — the occupant + its logic/specs: `prx verbspec prx-config disposition`

## Done & merged to `prx/main`

| PR | What |
|----|------|
| #711 | Seeded `bounded: { tagline, kind }` on all 23 packages |
| #713 | Added the `"seam"` keyword to the 6 then-current seams (`fs proc env gh git cas`) |
| #715 | `test/architecture/bounded-metadata.test.ts` — enforces the `bounded` invariant on every package |

The invariant test means a new `@bounded-systems/*` package **cannot merge** without
a well-formed `bounded` block (`tagline === description`, `kind ∈ door|room|guest`).

## The coupling (as it exists in `bounded-systems/site`)

- **Generator:** `scripts/gen-seams.mjs` → renders into marked regions of `index.html`.
- **Config + cache:** `data/seams.json` — `source.repo = bounded-systems/prx`,
  `source.packagesDir = packages`, `source.seamKeyword = "seam"`. Current seam set
  is **6**: `fs proc env gh git cas`.
- **`--from-prx`:** per seam, fetches
  `https://raw.githubusercontent.com/bounded-systems/prx/main/packages/<name>/package.json`,
  reads `pkg.bounded.tagline`, falls back to the seed copy (with a warning) if absent.
  *This is the tagline cutover and already works against merged prx.*
- **`prxSeams()`** (used by `--reconcile`): lists `packagesDir` via the GitHub API,
  reads each `package.json`, **selects packages whose `keywords[]` includes
  `source.seamKeyword`** (`"seam"`). ← the line #1 changes.
- **`--check`:** compares the rendered grid against `index.html`; exit 1 if stale.
  This is the PR gate.
- **`--reconcile`:** reports added/dropped seams; exit 1 on breakage — but **non-fatal
  in the workflow**.
- **Automation:** `.github/workflows/sync-seams.yml` — cron **`17 7 * * *`** +
  `workflow_dispatch`. Scheduled/dispatch runs `--reconcile` (non-fatal) → `--from-prx`
  → opens PR `seam-sync/<timestamp>` *"chore(seams): sync capability-seam grid from
  prx"*. PRs touching `index.html` / `data/seams.json` / `scripts/gen-seams.mjs` run
  `--check`.

**Net:** taglines for the existing 6 seams cut over automatically at the next 7:17 UTC
run. No further action is needed *for those 6*.

## Remaining work

### #2 — Decision (do this first; it's a product call)

Scope the grid to **doors only** (recommended). The honest "capability seam" *is* the
door. Consequence: the visible set changes **from 6 → the 12 `door` packages**, and
**`cas` drops out** (it is a `room`). If you want a different set, that changes #1's
selector — decide before implementing.

### #1 — `gen-seams.mjs` change (needs `site` write access)

Assuming doors-only:

1. In `prxSeams()`, replace the keyword filter with: select packages where
   `pkg.bounded?.kind === "door"`.
2. Remove the `source.seamKeyword` dependency; delete the field from `data/seams.json`.
3. (Optional) carry `bounded.kind` through so the grid can group/label by kind.
4. Run `node scripts/gen-seams.mjs --reconcile`, then `--from-prx`, to populate the 12
   doors' taglines into `data/seams.json` and regenerate `index.html`; then `--check`
   must pass.
5. ⚠️ The grid grows 6 → 12 — **review the `index.html` / `styles.css` layout** (built
   on `@bounded-systems/brand`); it may need design attention.
6. Open a draft PR on `site`.

### Post-#1 cleanup in prx (optional, low priority)

Once selection is `bounded.kind`-based, the `"seam"` keyword added in #713 is vestigial
and can be removed. Harmless if left.

### #5 — Cold read (human-only)

Send the hero/seam instrument to a fresh reader; the loop closes when their first
reaction is "…and I know what to run first."

## The blocker

#1 (and the optional prx cleanup PR) cannot be done from a `prx`-only session: the
GitHub access is scoped to `bounded-systems/prx`, and there is no repo-add tool in that
session. Add `bounded-systems/site` to a session's scope, then #1 is roughly an hour
including the layout review.
