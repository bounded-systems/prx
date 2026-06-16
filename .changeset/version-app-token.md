---
---

`version.yml` mints a GitHub App token (repo var `CHANGESETS_APP_ID` + secret `CHANGESETS_APP_PRIVATE_KEY`) to push the release branch and open the "Version Packages" PR, falling back to `GITHUB_TOKEN` when unset. Lets "Allow Actions to create/approve PRs" be turned back off (prx-m1hs) and makes the release PR trigger CI. CI/tooling only, no release.
