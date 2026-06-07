---
"@bounded-systems/prx": patch
---

test(prx): make pr-state/status-report testable + cover it → 100%

`refreshTaskSignals` read the worktree branch + live PR signals through direct
git/gh imports, so its signal-reconciliation logic was untestable (the file sat
at ~19%). Add a `StatusSignalsDeps` seam (loadReviewConfig / currentBranchName /
fetchPrSignalInfo, defaulting to the real impls), threaded through `renderStatus`,
so every reconciliation branch is drivable against an on-disk task-contract
fixture with no git branch or GitHub round-trip. 19% → 100%.
