---
---

internal: `prx fetch slack` core (prx-agd) — the freshness + CAS sync engine over
the slack read. `runFetchSlack` reads channel history since a watermark, keeps
only strictly-newer messages, content-addresses each (channel-scoped, canonical),
persists the unseen ones to the CAS BlobStore (idempotent — a re-run stores
nothing new), and advances a monotonic watermark on Slack `ts`. Pure core (read +
store injected); the CLI verb, the slack-surface read adapter, watermark storage,
and rate-limit/budget gating are follow-on slices (mirroring `fetch gh-issues`).
No package release.
