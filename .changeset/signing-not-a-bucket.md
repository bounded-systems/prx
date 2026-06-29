---
"@bounded-systems/prx": patch
---

Drop the prx-signing bucket: `git_ssh_signing_keys` is a user/account permission (user-to-server OAuth), not an installation `default_permissions` scope — confirmed empirically (the live bounded-systems-prx app never held it despite declaring it; the App-manifest flow rejects it). Remove the incoherent `.github/apps/prx-signing.manifest.json` and correct the architecture doc + README: keeper SSH signing is a user-auth concern (prx-dqf), not an installation-token bucket. The bucket model is two apps (prx-forge, prx-projects).
