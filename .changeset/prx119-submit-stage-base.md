---
"@bounded-systems/prx": patch
---

Fix `prx submit stage` resolving the patch base from the LOCAL `main` ref
(prx-3f1 / #119). The local branch drifts from `origin/main` during a long
orchestration or an external push, and both drift directions corrupt the
artifact: a local ref that lags folds the intervening main commits into the
patch as additions, one that leads renders them as reverts (observed: 76KB
across 34 files for a real 10-file change).

The base commit is now the merge base of `HEAD` with the base branch's
remote-tracking ref (`main@{upstream}`, else `origin/main`) — the fork point,
which is what makes the patch exactly the unit's own change. The tip of the
remote ref is not enough on its own: it produces the mirror-image bug for a unit
cut before the remote advanced. Because a merge base does not move when
`origin/main` gains commits on top, the result is also insensitive to how
recently the ref was fetched, so `stage` stays a pure git READER — no `fetch`,
keeper remains the sole git-writer.

`baseRef` in the artifact is unchanged (still the branch `publish` opens the PR
against); `baseSha` is now the fork point. `stage` renders a new `base-from:`
line naming the rev the base came from, which flags a base taken from a local
ref in repos with no remote-tracking branch.
