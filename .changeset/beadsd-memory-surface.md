---
"@bounded-systems/prx": minor
---

Add the bd memory surface (`recall` / `memories` / `remember`) to the beadsd wire contract and daemon dispatch (prx-44y, GH-296 / GH-1003). `recall` (read one row by key) and `memories` (read rows by key prefix) join the read kinds; `remember` (upsert a row) joins the policy-gated single-writer set and dispatches under the planner role like every other write. `forget` (destructive) is intentionally absent — it is not on the bd allowlist.

This is the daemon-side infra for routing the structured-handoff queue (GH-1397) and memory/compact store through the one canonical clone. It's the fix for the prx-44y root cause — handoff rows are bd-memory writes that, going through raw `bd` from a worktree, never reach the canonical store (so `prx handoff enqueue` reports `created` while `prx handoff status` reads nothing). Wiring `handoff/store.ts` onto this daemon surface is the follow-up.
