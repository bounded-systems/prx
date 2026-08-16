# prx-ebo — Sync API efficiency: where the requests go, and how to cut them (ADR)

> Design-only spike. Grounds the "syncing ate more API requests than necessary"
> concern in what `prx beads sync` actually does, and sequences the fixes by
> safety + payoff. No `src/` changes in this unit. Written 2026-06-07.

## 0. Status

**Accepted (plan).** Two independent levers, in this order:
1. **Pull-leg conditional reads** (GitHub ETags / GraphQL batching) — the hog.
2. **Push-leg bead-etag short-circuit** (with retry-safety) — the cheap, safe win.

## 1. Where the requests actually go

`runBeadsSync` (`src/sync/run.ts`) is a bidirectional reconcile over the
*known pinned* `(uow, domain)` pairs, in three phases:

- **pull leg (GH → bd):** iterates **every** pinned pair and reads its GitHub
  issue state. **Not `--limit`-gated** (invariant I-DS3). ⇒ **N GitHub reads
  per tick, every tick, whether or not anything changed.** This is the waste.
- **close-apply:** `adapter.bulkClose` for pairs whose GH issue went closed.
- **push leg (bd → GH):** `gh issue edit` (title/body), `--limit`-gated. The GH
  **write** requests.

The dolt HEAD etag (#485) tells us the **bead** side hasn't moved — which bounds
the **push** leg, not the pull leg. So the two halves need different fixes.

## 2. Lever 1 — pull-leg conditional reads (the hog)

The pull leg re-reads unchanged GH issues every tick. Options:

- **GitHub conditional requests (ETags):** store each issue's `ETag`; send
  `If-None-Match` → a `304` is **free against the rate limit**. Caveat: the
  high-level `gh issue view/list` commands don't expose ETags/304 — this needs
  `gh api` (REST) with header handling, or
- **GraphQL batching:** one GraphQL query fetching state for K pinned issues at
  once (the budget gate already counts GraphQL points) — fewer round-trips, and
  pairs with an `updated_at` older than our last tick can be skipped client-side.

Recommend GraphQL batching + an `updatedAt`/ETag skip filter. This is the real
"too many requests" fix and is a focused reconcile-layer change.

## 3. Lever 2 — push-leg bead-etag short-circuit (cheap, safe)

The push leg is bd-authoritative (title/body). If the bead store hasn't moved
since the last **successful** push, there is nothing to push:

- Persist `lastPushedHead` (per repo).
- Skip the push phase when `currentHead == lastPushedHead`.
- **Retry-safety:** only set `lastPushedHead = currentHead` when the push phase
  fully succeeded (no deferrals via `--limit`, no per-pair errors). A failed or
  partial push leaves `lastPushedHead` stale, so the next tick retries. (Without
  this, a failed push would never retry until a bead changed.)

Uses the etag the daemon already surfaces (#485); `runBeadsSync` is async so it
can read the generation directly. Bounded, but the retry-safety state is the part
to get right.

## 4. Sequence

1. Lever 2 first if a quick win is wanted (small, but watch retry-safety), **or**
2. Lever 1 for the bulk of the savings (the pull leg is the actual hog).

Both are correctness-sensitive reconcile changes — do them in a focused session,
not bundled with unrelated work.
