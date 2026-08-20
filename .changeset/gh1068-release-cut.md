---
---

CI-only: add `release-cut.yml`, which cuts the release tag under the workflow's
own identity and dispatches `release-binary.yml` at the new tag (#1068, mint#22).
No package codepath changes, so this changeset is empty.
