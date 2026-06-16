---
---

ci: fix coverage no-lcov root cause + make the coverage gate fail-closed (GH-664).

Root cause: bun writes the coverage report at process exit relative to the current cwd. A test that `process.chdir()`s without restoring (e.g. the chdir sites in `pr-state/cli.test.ts`) left cwd in a temp dir, so `coverage/lcov.info` was written there instead of the repo root — CI saw "No coverage report found" while the text reporter still printed. The test preload now restores cwd after every test.

Defence in depth: `coverage-summary.ts` previously skipped (exit 0) when `coverage/lcov.info` was absent, so a no-data run passed as green and the 85% floor became a no-op. When a gate flag (`--min`/`--per-file-min`) is set, a missing or empty report now fails (exit 1); report-only invocations (no gate flag) still exit 0. Adds tests for the fail-closed behaviour. No product code changes.
