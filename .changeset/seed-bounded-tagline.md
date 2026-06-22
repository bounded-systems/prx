---
---

Seed every workspace package with a `bounded` block (`{ tagline, kind }`) so prx
is the source of truth for the website seam grid — the `--from-prx` generator
reads `bounded.tagline` directly. `tagline` mirrors each package's `description`;
`kind` classifies it by the codebase's own door/room/guest paradigm. Also
normalizes the `cas` description (drops a stray trailing period). Metadata only:
no API or behavior change, no package release.
