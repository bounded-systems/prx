---
"@bounded-systems/prx": patch
---

`prx triage close` now reads and closes through beadsd (GH-296 wave 2) instead of local `execBd`: a targeted `showBeadViaDaemon(<id>)` lookup + `closeBeadViaDaemon`, so the close lands on the one canonical beads. First internal write call-site flipped onto the daemon write helpers; `runTriageClose` is now async.
