---
"@bounded-systems/bd": minor
"@bounded-systems/prx": minor
---

Extend the beadsd-door gate to the direct bd-read spawn sites. A new shared `bdDoorGate(cmd, env, dialer?)` primitive in `@bounded-systems/bd` (which `defaultBdGithubRunner` now reuses) door-gates any raw `bd` command array. prx adds `doorGatedCommandRunner` / `doorGatedSpawnCapture` wrappers (and the `bdCommandRunner` / `bdSpawnCapture` defaults), and the in-box bd reads — `pipeline/agent-result` (`bd list`), `pipeline/edges/intake-triage` (`bd show`), and `beads/workspace_mode` probe (`bd list`) — now route through them, so they reach the beadsd door in the box profile instead of execing a local `bd`. Off-profile behavior is unchanged. Host-only dolt/bootstrap/doctor management spawns are intentionally not door-routed (the door cannot express daemon-management ops).
