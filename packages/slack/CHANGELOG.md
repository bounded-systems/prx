# @bounded-systems/slack

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
