---
"@bounded-systems/prx": patch
---

Harden the beads write-side workspace-affinity guard against an unregistered cwd
(prx-7odk). prx-9e86 decided by bd prefix, but a cwd not in the repo inventory
resolves to a null prefix → the guard allowed the write, so a cross-repo write
from an unregistered checkout slipped through. `resolveWorkspaceAffinity` now
falls back to git-remote repo identity when the prefix is unresolvable: it
refuses only on a POSITIVE cross-repo mismatch (both identities resolved and
differing), and still allows a same-repo or undeterminable cwd — no
over-blocking. The refusal message names the repo identities in that case.
