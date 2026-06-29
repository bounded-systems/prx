---
"@bounded-systems/prx": patch
---

Distinguish fully-backed (live checks) from evidence-backed value props in
STATUS.md and the value-props doc.

STATUS.md previously said "5 of 5 value props backed · 0 learning goals" —
accurate but misleading (two props are backed by evidence from merged PRs, not
by repeatable live checks). The new rollup reads
"3 of 5 value props fully backed · 2 evidence-backed … · 0 learning goals"
with evidence-backed props tagged `_(evidence-backed)_` in the body.

Softens the README description from "git-writes signed and verified against
their owner" (overclaims universal ownership verification) to
"git-writes signed by a capability-gated actor" (accurate today: opt-in,
git-only, by role not full ownership).
