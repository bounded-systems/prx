---
"@bounded-systems/prx": minor
---

feat(fetch): `prx fetch slack` drains the history cursor so one run gets the whole channel (prx-13x)

The pure core now pages `conversations.history` from the watermark to the end
of the delta (cursor pagination) instead of reading a single page, so
`prx fetch slack <channel>` fetches **all** messages newer than the watermark
in one run — no gap when a channel has more than `--limit` new messages. The
read adapter surfaces the provider's `next_cursor`; the core loops until the
cursor drains, a `--max-pages N` bound is hit, or the cursor stops advancing
(defensive against a stuck cursor). Messages are deduped by `ts` across pages;
the watermark advances once to the global max; the JSON summary reports
`pages`.

Defaults to draining the full delta; `--max-pages N` caps the pages per run
(`--max-pages 1` restores the old single-page behaviour). Rate-limit/budget
gating remains a follow-on (blocked on slackd, prx-tgy) — Slack has no
github-budget points bucket.
