---
"@bounded-systems/prx": minor
---

Add `prx repo list --list-submodules` — prints every discovered repo's
`.gitmodules` entries (submodule name, path, and url) across all of its
worktrees, for auditing where git submodules are used. Read-only; does not
touch or resolve anything.
