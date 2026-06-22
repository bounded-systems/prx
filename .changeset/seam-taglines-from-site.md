---
---

Replace each seam package's `bounded.tagline` with the curated homepage copy from
bounded.tools (`data/seams.json`) instead of mirroring the verbose `description`.
This makes prx the source of truth for the website seam grid without the
`--from-prx` generator degrading the page's copy: `fs` → "the one filesystem
door", `proc` → "the one subprocess spawn", `env` → "the one reader of
process.env", `gh` → "GitHub CLI, policy-gated", `git` → "git CLI,
lock-recovering", `cas` → "bytes addressed by digest". Metadata only: no API or
behavior change, no package release.
