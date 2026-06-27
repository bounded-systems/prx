---
"@bounded-systems/prx": patch
---

Correct the `gitAiAgent` comment in the home-manager module (prx-q9yj follow-up).

The merged comment claimed `GIT_AI_CUSTOM_ATTRIBUTES` is "persist[ed] into the
authorship note `custom_attributes`" with a local jq metric recipe. Verified
false (git-ai 1.6.3): the local note schema (`authorship/3.0.0`) has no
`custom_attributes` field — that data only flows to git-ai's cloud upload path
(`GIT_AI_API_KEY`). The local jq recipe always returns nothing.

Comment now states the real scope: the export is the cloud on-ramp (inert
without git-ai cloud), and a *local* prx-vs-bypass metric needs a different
instrument. No behavior change — the `export` is unchanged.
