---
"@bounded-systems/prx": patch
---

`prx repo list --everywhere`'s discovery walk now recognizes a bare repo by
its actual on-disk shape (presence of a `HEAD` file) rather than requiring
the `*.git` naming convention — a bare repo without that suffix was
previously invisible to the whole candidate-selection step, not just
filtered incorrectly. The same structural check also cheaply skips obvious
naming false positives (a stray dotfile like `.envrc.git`) before spending a
`git rev-parse` subprocess spawn to reject them. Deliberately checks only
for `HEAD` — not `objects/`/`refs/` — since a repo using git's newer
`reftable` ref-storage format (2.44+) may not have a conventional `refs/`
tree, and a false negative here silently drops a real repo from the scan
with nothing downstream to catch it.
