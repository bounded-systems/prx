---
---

internal: `slack-scout` standalone binary (prx-hkm). Extract the slack
composition root into `packages/prx/src/slack/scout-cli.ts` (`execSlackScoutRead`)
— used by BOTH the `prx scout slack` verb (dedups the cli.ts handler) and a new
Bun-compiled `slack-scout` executable (`src/slack/bin.ts`, `bun run
slack-scout:build` → `dist/slack-scout`). Read-only, self-contained (bundles
slack + auth/policy/cas/anchored-chain), same token flow (`op run`). The seed of
slackd's serve mode (prx-tgy) and a future standalone repo (prx-hkm path B). No
package release.
