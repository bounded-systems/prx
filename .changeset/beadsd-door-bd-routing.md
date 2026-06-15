---
"@bounded-systems/bd": minor
"@bounded-systems/prx": minor
---

Route bd-backed verbs through the beadsd door in the box profile. `execBd` and `defaultBdGithubRunner` now gate on a `PRX_BEADS_DOOR` signal: in the box profile they never spawn a local `bd`, instead dialing the door via a registered, daemon-agnostic `BdDoorDialer` (new `registerBdDoorDialer` / `isBdDoorMode` exports) or failing closed with the door + provisioning path. prx registers the production dialer at `runCli` startup, mapping reads (list/ready/show) onto `prx beads <verb>`. Off-profile behavior is unchanged. Door wiring + the box-profile signal are owned by prx-asr / prx-634.
