---
---

ci: make the coverage gate fail-closed on a missing/empty lcov report (GH-664).

`coverage-summary.ts` previously skipped (exit 0) when `coverage/lcov.info` was absent, so a coverage run that produced no data passed as green and the 85% floor became a no-op. When a gate flag (`--min`/`--per-file-min`) is set, a missing or empty report now fails (exit 1); report-only invocations (no gate flag) still exit 0. Adds a test for the fail-closed behaviour. No product code changes.
