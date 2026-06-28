---
"@bounded-systems/prx": patch
---

Add app-as-code manifests for the permission-bucketed GitHub Apps (Phase 2 of prx-zee7): `.github/apps/{prx-forge,prx-projects,prx-signing}.manifest.json`, splitting the union `bounded-systems-prx` manifest into coarse least-privilege buckets (forge = contents/issues/PRs/checks; projects = organization_projects; signing = git_ssh_signing_keys, isolated). These are the def-of-record to register the apps from; the union app stays until cutover. Per docs/prx/github-apps-architecture.md.
