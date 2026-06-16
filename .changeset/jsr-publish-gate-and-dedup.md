---
---

Fix JSR release automation: the version-dedup check used `?limit=` which makes the JSR versions endpoint return an empty page (so it re-published already-published versions); drop the param. Add a readiness gate so only packages with a clean `jsr publish` are auto-published — the other @bounded-systems/* packages are held (skipped, not failed) so `release.yml` stays green. CI/packaging only, no package release.
