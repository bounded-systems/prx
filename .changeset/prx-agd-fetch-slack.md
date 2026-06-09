---
"@bounded-systems/prx": minor
---

feat(fetch): `prx fetch slack <channel>` — sync a channel's reads to CAS with a per-channel watermark (prx-agd)

Wraps the pure freshness/CAS core (`runFetchSlack`) with its three production
seams: the gated `scout slack` read surface (now accepting `oldest`/`latest`),
the on-disk plan-store CAS on a new `slack` domain (deduping each
`conversations.history` message by content digest), and a per-channel
`bd config` watermark (`prx.fetch.slack.<channel>.watermark`) advanced to
`max(ts)` after each successful fetch. Idempotent end-to-end.

Scope (v0): one read per run. Multi-page pagination (the `cursor` carry) and
rate-limit/budget gating are deliberate follow-ons — Slack has no
github-budget points bucket, so meaningful gating belongs with slackd
(prx-tgy). Parent epic: prx-zes.
