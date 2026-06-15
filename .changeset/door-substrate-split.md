---
---

Internal refactor (no release): split the shared door-transport substrate
(`framing`, `transport`, `lima-exec`) out of `keeperd/` into `src/door/`, so the
keeper-only module can later be extracted to its own repo without breaking the
beadsd / session-host / lima daemons that share the framing. No public API or
behaviour change. (prx-8vdr; prx-o92 foundation.)
