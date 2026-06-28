---
"@bounded-systems/prx": patch
---

Fix bucket app manifests after Phase 3 registration (prx-zee7): prx-forge gains `contents:write` (needed to push the changeset release branch + merge PRs — it absorbs the Changesets app); prx-signing gains the required `hook_attributes` (the manifest flow rejects a blank hook). Record the registered app_ids/installation_ids + the live-forge `contents` bump in .github/apps/README.md. (prx-signing remains unregistered — the flow rejects `git_ssh_signing_keys`; deferred to prx-dqf.)
