---
---

Fix the zod-using leaf packages for JSR: add a zod import map (npm:zod) to each jsr.json so deno publish resolves the bare specifier, and pass --allow-slow-types in publish-jsr.yml (parity with release.yml). disposition/machine-schema/prx-config/verbspec now publish (added to READY); proc/bd/github-budget carry the fix but stay held pending policy (JSR new-package quota). CI/release config only.
