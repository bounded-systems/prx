---
"@bounded-systems/prx": patch
---

`prx home update` now sets `MAIN_GUARD_ALLOW_PROTECTED_BRANCH=1` on its own flake.lock commit, so it no longer fails when the flake dir is checked out on a protected branch (main/master/trunk) — a routine case for `~/.config/home-manager`.
