---
"@bounded-systems/prx": patch
---

`prx beads provision` (and `prx lima provision-beads`) now `chmod 700` the `.beads` directory it creates, so bd no longer warns about insecure `0755` permissions on the provisioned canonical clone.
