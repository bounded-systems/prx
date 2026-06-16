# @bounded-systems/slack

## 0.2.0

### Minor Changes

- 94255ea: Make the Tier-2 packages publish-ready as standalone packages.

  For each of `repo-root`, `github-budget`, `scout`, `slack`, `bd`, `gh`, and `git`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`. Each build's `tsconfig.build.json` overrides `paths: {}` so workspace deps resolve as external built declarations.

  All seven depend only on already-packaged packages, and all already carried extractability tests. Also fixes three undeclared-dependency gaps surfaced while packaging (each was imported but not declared, which would break a standalone install):

  - `repo-root` now declares `@bounded-systems/proc`.
  - `scout` now declares `@bounded-systems/anchored-chain-sqlite`.
  - `slack` now declares `@bounded-systems/anchored-chain-sqlite`, `@bounded-systems/auth`, `@bounded-systems/env`, and `@bounded-systems/proc`.

### Patch Changes

- Updated dependencies [37b0b70]
  - @bounded-systems/auth@0.2.0
  - @bounded-systems/proc@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [8c1b8c5]
- Updated dependencies [2f4b731]
  - @bounded-systems/anchored-chain@0.2.0
  - @bounded-systems/policy@0.2.0

## 0.1.0

### Minor Changes

- c07c07c: feat(slack): org/channel/thread capability scope on the slack read key (prx-q7r)

  The minted Slack capability can now be scoped along three nested dimensions —
  **org ⊃ channel ⊃ thread**. `SlackKeyScope` gains `orgs?` (workspace/enterprise
  team id) and `threads?` (parent-message ts) alongside the existing `channels?`;
  each is enforced independently and only when both the key constrains it and the
  read targets it (the convention `channels` already used), so an org-scoped key
  authorizes every channel/thread within that workspace.

  `ScopedSlackKey.authorize` moves from positional `(op, channel, req)` to a
  structured `(target: SlackAuthTarget, req)` so org/thread can be enforced; the
  webapi transport builds the target from params (`team_id` → org, `channel` →
  channel, the replies parent `ts` → thread), and `execSlackRead` derives the
  narrowest per-read scope across all three. The public read surface
  (`execSlackRead` / `execSlackScoutRead`) is unchanged.

  This is the capability _model_ + enforcement. The grant policy — minting a
  broad org-scoped key under a profile — lands with slackd (prx-tgy). Parent
  epic: prx-zes.
