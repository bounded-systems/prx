---
---

internal: add the `@bounded-systems/slack` read surface (epic prx-zes) — a
policy-gated, provenance-tracked, read-only Slack reader built on the keymaker +
a swappable transport port, with a Web API transport proven against live Slack.
Registers `slack` as a read-only tool in `@bounded-systems/policy` (writes
hard-blocked) and resolves Slack root authority in `@bounded-systems/auth`
(keymaker). All packages are private (no release). Regenerated the actor
sub-agent docs from the policy table.
