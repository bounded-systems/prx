---
"@bounded-systems/prx": patch
---

Additive testability seams (behavior-preserving): the intake→triage default
UoW reader is now built via `uowReaderWith(run = defaultRunner)`, and
`runGhAuthStatus` / `runGhApiUserLogin` take an injectable `spawn` (defaults to
the real proc). Production call sites pass nothing.
