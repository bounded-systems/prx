# @bounded-systems/git

## 0.0.2

### Patch Changes

- Updated dependencies [2f4b731]
  - @bounded-systems/env@0.2.0
  - @bounded-systems/policy@0.2.0
  - @bounded-systems/fs@0.2.0
  - @bounded-systems/proc@0.0.1

## 0.0.1

### Patch Changes

- e6ce632: `execGit` commits/tags headless-safe: inject `-c commit.gpgsign=false` /
  `-c tag.gpgsign=false` at the single git seam. prx's provenance signing is ed25519
  over the chain (keeper's commit-tree), never git's gpg/ssh commit signing — which
  is the operator's config and fails in non-interactive/agent contexts (e.g. 1Password
  SSH: "agent returned an error" → "failed to write commit object"). This makes every
  prx git caller (keeper, `prx tools git`, the executor leg) robust regardless of the
  operator's `commit.gpgsign` — the production counterpart to the test-fixture
  hermetic fix (GH-360/GH-388).
