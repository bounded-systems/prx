---
---

CI-only: `release-cut.yml` guard 3 now counts only changesets that declare a
package bump, so an empty (no-codepath) changeset no longer blocks a release cut
(#1068). No package codepath changes, so this changeset is empty — which is
exactly the case the fix is about.
