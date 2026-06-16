---
---

Make the leaf packages JSR-publishable: declare `zod` as a dependency (not just a peerDependency) on `machine-schema`, `disposition`, `prx-config`, `verbspec` so JSR's byonm publish can resolve it, and add `--allow-slow-types` to the single-package `publish-jsr` workflow (matching `release.yml`). These 4 leaves are now published on JSR and added to the auto-publish READY set. Part of prx-zavp. CI/packaging only, no release.
