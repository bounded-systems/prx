---
---

internal: break the `cli-types.ts ⇄ plan-close-bd.ts` import cycle (a
dependency-cruiser `no-circular` regression introduced when `planClose` moved to
the leaf). `PlanCloseResult` / `PlanCloseReason` now live in `plan-close-bd.ts`
next to the driver that produces them, removing both edges. Type-only move — no
behavior change. No package change.
