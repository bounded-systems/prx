---
---

internal: add `prx scout slack <op>` (epic prx-zes .9) — expose the slack read
surface as a scout source. The composition root (keymaker over the Slack
credential + Web API transport) drives execSlackRead; the verb emits one JSON
envelope the dispatch layer turns into a `slack://sha256:…` handle, with the
`slack.read/v1` provenance derivation. Read-only ops: channels|history|thread|
users. Transport is a port — swaps to a daemon-routed transport (slackd, prx-tgy)
later with no surface change. No package release.
