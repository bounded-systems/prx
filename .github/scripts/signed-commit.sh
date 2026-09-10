#!/usr/bin/env bash
# Create a SIGNED commit on a branch, via the GitHub GraphQL API.
#
# WHY THIS EXISTS
# `git commit` + `git push` produces an UNSIGNED commit no matter which token
# pushes it — App token, GITHUB_TOKEN, PAT, all the same. The org's
# `default-branch-protection` ruleset requires signed commits, so every
# release PR opened by version.yml and release-binary.yml was BLOCKED and had
# to be merged with `gh pr merge --admin`. Two overrides per release, and an
# override that becomes routine stops being a control.
#
# Commits created through `createCommitOnBranch` are signed by GitHub itself,
# so the rule is satisfied rather than bypassed. No signing key, no PEM in the
# repo — which is the same posture the broker mint already takes for tokens.
#
# USAGE
#   .github/scripts/signed-commit.sh <branch> <message>
#
# Commits every change in the working tree (adds, edits, deletes, untracked —
# .gitignore honoured), exactly like `git add -A && git commit`. Exits 0
# without committing when the tree is clean, so callers can invoke it
# unconditionally.
#
# Requires: GH_TOKEN with contents:write, GITHUB_REPOSITORY, jq, gh.
# The branch is force-pointed at the current HEAD first, so this replaces
# `git checkout -B <branch>` + `git push -f` as well as the commit.
set -euo pipefail

branch="${1:?usage: signed-commit.sh <branch> <message>}"
message="${2:?usage: signed-commit.sh <branch> <message>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

base_sha="$(git rev-parse HEAD)"

# Stage everything so a single diff enumerates adds, edits and deletes.
git add -A
if git diff --cached --quiet; then
  echo "signed-commit: working tree clean, nothing to commit"
  exit 0
fi

# createCommitOnBranch needs the branch to exist and its head to equal
# expectedHeadOid. Point it at our base commit — creating it if this is the
# first release on that name, force-updating if a previous run left it behind.
if gh api "repos/${repo}/git/ref/heads/${branch}" >/dev/null 2>&1; then
  gh api -X PATCH "repos/${repo}/git/refs/heads/${branch}" \
    -F sha="${base_sha}" -F force=true >/dev/null
else
  gh api -X POST "repos/${repo}/git/refs" \
    -f ref="refs/heads/${branch}" -f sha="${base_sha}" >/dev/null
fi

# Build fileChanges on disk, never in argv. A file's base64 body is a single
# argument if passed with `--arg`, and Linux caps one argument at 128 KiB
# (MAX_ARG_STRLEN) — CHANGELOG.md alone is ~240 KiB encoded, so the first
# real run of this script died with `jq: Argument list too long` and every
# version.yml run since #1080 failed at this point (#434). `--rawfile` and
# `--slurpfile` read from files, so the size of what is committed no longer
# bounds what can be committed.
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

: > "${work}/additions.ndjson"
while IFS= read -r -d '' path; do
  base64 < "${path}" | tr -d '\n' > "${work}/contents.b64"
  jq -nc --arg p "${path}" --rawfile c "${work}/contents.b64" \
    '{path: $p, contents: $c}' >> "${work}/additions.ndjson"
done < <(git diff --cached --name-only -z --diff-filter=ACMR)

: > "${work}/deletions.ndjson"
while IFS= read -r -d '' path; do
  jq -nc --arg p "${path}" '{path: $p}' >> "${work}/deletions.ndjson"
done < <(git diff --cached --name-only -z --diff-filter=D)

read -r -d '' query <<'GRAPHQL' || true
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
  }
}
GRAPHQL

# --slurpfile collects every JSON value in the file into one array — the
# additions/deletions lists exactly, and [] for an empty file.
jq -nc \
  --arg q "${query}" \
  --arg repo "${repo}" \
  --arg branch "${branch}" \
  --arg headline "${message}" \
  --arg oid "${base_sha}" \
  --slurpfile additions "${work}/additions.ndjson" \
  --slurpfile deletions "${work}/deletions.ndjson" \
  '{query: $q, variables: {input: {
      branch: {repositoryNameWithOwner: $repo, branchName: $branch},
      message: {headline: $headline},
      expectedHeadOid: $oid,
      fileChanges: {additions: $additions, deletions: $deletions}
    }}}' > "${work}/body.json"

oid="$(gh api graphql --input "${work}/body.json" --jq '.data.createCommitOnBranch.commit.oid')"

[ -n "${oid}" ] || { echo "::error::createCommitOnBranch returned no commit oid"; exit 1; }

# Assert the thing this script exists to guarantee. If GitHub ever stops
# signing API-created commits, fail here — loudly, at the point of cause —
# rather than letting a release PR get quietly blocked again downstream.
verified="$(gh api "repos/${repo}/commits/${oid}" --jq '.commit.verification.verified')"
if [ "${verified}" != "true" ]; then
  reason="$(gh api "repos/${repo}/commits/${oid}" --jq '.commit.verification.reason')"
  echo "::error::commit ${oid} is NOT signed (reason: ${reason}) — the ruleset will block this PR"
  exit 1
fi

echo "signed-commit: created ${oid} on ${branch} (verified)"

# Leave the local checkout consistent with what we just pushed, so any later
# step in the same job sees a clean tree rather than the staged changes.
git reset --hard "${base_sha}" >/dev/null
