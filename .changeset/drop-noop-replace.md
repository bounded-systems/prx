---
---

Drop a no-op `.replace(/\.ts$/, ".ts")` identity replacement in the
`extract-module` codemod script (clears CodeQL alert #54, `js/identity-replacement`).
Codemod tooling only — no product runtime change, no release.
