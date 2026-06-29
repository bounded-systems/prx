---
"@bounded-systems/prx": minor
---

Remove the interactive `prx tui` board UI (prx-fdf, slice 1 of the TUI
retirement). Deletes `pr-state/tui.ts` + its test, the `tui` registry verb,
the cli `tui` command/parse/dispatch (the `prx:tui` script it shelled to no
longer existed), and the `prx tui` lines from the scaffold/agents-md/help
surfaces. The canonical mainx promoted set drops from five to four
(`plan session`, `next`, `do`, `plan handoff`). The board projection
(boardStatus) is untouched.
