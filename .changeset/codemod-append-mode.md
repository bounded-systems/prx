---
---

tooling: teach the `extract-module` codemod to append into an existing leaf
(load + merge imports + dedup) instead of only creating a new sibling, so §4
Stage-0 extractions that move declarations into an existing module can go through
the tool. No package change.
