---
"@bounded-systems/prx": patch
---

Make the test suite hermetic against the operator's git signing config. Many tests
`git commit` throwaway fixture repos that fell back to the operator's global
`~/.config/git/config` — which, with an interactive signer (e.g. 1Password SSH),
fails headless and broke `prx ci` (and so the pilot's local `checking` gate,
GH-360). The bun-test preload now points git's global/system config at a hermetic
file (identity set, signing off), isolating fixture commits from the operator setup.
