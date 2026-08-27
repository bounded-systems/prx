---
"@bounded-systems/prx": major
---

Retire the home verbs: `prx home update`, `prx home sync`, and `prx upgrade` are
removed, along with `home-update.ts` and `home-sync.ts`.

All three were spellings of one handler that shelled out to `nix flake update` +
`home-manager switch` against a flake dir prx resolved itself — `--flake-dir`,
then `PRX_HOME_FLAKE_DIR`, then a default of `~/.config/home-manager`. That
default is the failure mode: on a machine whose user layer has moved to a
different flake, the guessed dir still evaluates, so the switch *succeeds* while
quietly applying a configuration the operator is not editing. Files added to the
real config simply never appear, with no error to explain it. Consumers papered
over this by exporting `PRX_HOME_FLAKE_DIR`.

Updating prx is an ordinary flake operation and belongs in the consuming config,
not behind a prx verb that guesses which config that is.

**Migration.** Replace `prx upgrade` (and `prx home update`) with, in whichever
flake actually pins prx:

```sh
nix flake update prx
home-manager switch --flake .#<name>
```

`prx home sync` additionally detached the mainx worktree first; do that with
`git fetch` + `git checkout --detach origin/main` in that repo.

`homeUpdate.inputs` in `~/.config/prx/config.json` is no longer read. A stale
block under that key is ignored, so no config edit is required.
