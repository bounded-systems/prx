---
---

Revert the 6 over-eager READY additions (disposition, fs, machine-schema, policy, prx-config, verbspec) — they fail the real CI publish (undeclared zod / not-yet-created on JSR), only the dry-run passed. READY back to the 8 actually-published packages so release.yml is green. CI/release config only.
