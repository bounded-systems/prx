---
"@bounded-systems/prx": minor
---

Canonical bare/worktree paths now derive their host segment from the actual
remote URL instead of a hardcoded `"io.github"` literal. Three independent
copies of that literal (`canonicalBarePathForRepo`/`canonicalWorktreePathForRepo`,
`canonicalBarePathFromParsed`/`canonicalMainxPathFromParsed`/`writeOverlayStub`,
and github.ts's `reverseDnsRepoSegments`) now share one `hostSegmentForHost`
function.

- `hostSegmentForHost` is a pure derivation (reverses a host's dot-separated
  labels), not a lookup table — any host with 2+ labels works automatically,
  not just GitHub. `gitlab.com` → `com.gitlab` is supported as of this
  release.
- `github.com` moves from `io.github` (reverse-DNS of the `github.io` Pages
  domain — never actually a property of the git host) to `com.github` (true
  reverse-DNS of `github.com` itself). Existing bare repos / worktrees under
  `io.github` are **not** migrated automatically — this is a one-time manual
  filesystem move (`mv .../repos/io.github .../repos/com.github`, same for
  `state/git/worktrees/`, plus rewriting the `.git`/`gitdir` pointers that
  reference the old absolute paths) before upgrading, or new repos will land
  in `com.github` alongside old ones still in `io.github`.
- Canonical path derivation now prefers the `upstream` remote over
  `origin`/primaryRemote when both are configured, so a fork's bare+worktree
  placement reflects its actual source rather than wherever the fork lives.
- Identity-hashing consumers (`canonicalDoltDatabase`, `workspace/actor.ts`'s
  workspace ledger id, `dolt/status.ts`'s dolt-server id) are **not**
  affected — they're pinned to the historical `io.github` value forever via
  a new `legacyGithubIdentitySegments`, since migrating them would silently
  orphan already-running dolt servers, live databases, and on-disk ledger
  files.
