---
---

internal: raise `pr-state/cli-format` from 80.1% → 87.8% past the per-file
floor — a new `cli-format.test.ts` exercises the previously test-free pure
`format*` projectors (work-unit/resolved/artifact/session/chain checks, gate
result, task graph + status, verb help, worktree-remove, remote-ci-check,
scout-logs) across both their plain and json faces. Test-only.
