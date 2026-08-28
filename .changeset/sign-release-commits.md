---
"@bounded-systems/prx": patch
---

Sign the commits that `version.yml` and `release-binary.yml` create, via the
GitHub GraphQL `createCommitOnBranch` mutation instead of `git commit` +
`git push`.

A git-pushed commit is unsigned whichever token pushes it — App token,
`GITHUB_TOKEN`, or PAT. The org's `default-branch-protection` ruleset requires
signed commits, so both release PRs were `BLOCKED` and had to be merged with
`gh pr merge --admin`: two ruleset overrides per release, on a control that
stops meaning anything once overriding it is routine. Commits created through
the API are signed by GitHub itself, so the rule is now satisfied rather than
bypassed. No signing key and no PEM in the repo, matching the posture the
broker mint already takes for tokens.

New `.github/scripts/signed-commit.sh` also creates or force-points the target
branch, so it replaces `git checkout -B` / `git push -f` as well as the commit.
It verifies its own output — if GitHub ever stops signing API-created commits
it fails at the point of cause rather than letting the PR be silently blocked
downstream again.
