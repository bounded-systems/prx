---
"@bounded-systems/prx": patch
---

Emit the pilot and fleet machines' own state transitions to the audit sink
(`machine:"pilot"` / `machine:"fleet"`), via `makeAuditInspector`. The monitor
already greps `machine:pilot`, so pilot retreats/loops are now observable —
the unblocker for diagnosing the implement/test loop (GH-360).
