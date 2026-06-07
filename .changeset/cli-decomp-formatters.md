---
---

internal: continue pr-state/cli.ts decomposition toward dropping it from MONOLITHS
— extract 60 pure formatter functions → cli-format.ts and 12 shared result types →
cli-types.ts (the types leaf that unblocks the formatters). Cycle-neutral. No
package version change.
