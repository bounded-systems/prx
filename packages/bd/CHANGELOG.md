# @bounded-systems/bd

## 0.1.0

### Minor Changes

- 2d158d5: Extend the beadsd-door gate to the direct bd-read spawn sites. A new shared `bdDoorGate(cmd, env, dialer?)` primitive in `@bounded-systems/bd` (which `defaultBdGithubRunner` now reuses) door-gates any raw `bd` command array. prx adds `doorGatedCommandRunner` / `doorGatedSpawnCapture` wrappers (and the `bdCommandRunner` / `bdSpawnCapture` defaults), and the in-box bd reads — `pipeline/agent-result` (`bd list`), `pipeline/edges/intake-triage` (`bd show`), and `beads/workspace_mode` probe (`bd list`) — now route through them, so they reach the beadsd door in the box profile instead of execing a local `bd`. Off-profile behavior is unchanged. Host-only dolt/bootstrap/doctor management spawns are intentionally not door-routed (the door cannot express daemon-management ops).
- 85a9179: Route bd-backed verbs through the beadsd door in the box profile. `execBd` and `defaultBdGithubRunner` now gate on a `PRX_BEADS_DOOR` signal: in the box profile they never spawn a local `bd`, instead dialing the door via a registered, daemon-agnostic `BdDoorDialer` (new `registerBdDoorDialer` / `isBdDoorMode` exports) or failing closed with the door + provisioning path. prx registers the production dialer at `runCli` startup, mapping reads (list/ready/show) onto `prx beads <verb>`. Off-profile behavior is unchanged. Door wiring + the box-profile signal are owned by prx-asr / prx-634.

### Patch Changes

- Updated dependencies [2f4b731]
  - @bounded-systems/env@0.2.0
  - @bounded-systems/policy@0.2.0
  - @bounded-systems/proc@0.0.1

## 0.0.1

### Patch Changes

- df7cb2e: Additive testability seams + a dead-code dedupe, all behavior-preserving:

  - `@bounded-systems/gh` — `execGh` gains optional `deps.spawn` / `deps.budget`
    seams so the rate-limit authority boundary is testable without a live `gh`
    spawn or real GitHub budget state. Existing call sites pass nothing.
  - `@bounded-systems/bd` — removed the redundant static `BLOCKED_SUBCOMMANDS`
    check (the policy `isBlocked` gate already enforced the identical list);
    policy is now the single source of truth, pinned by a `blockedSubcommands`
    parity test.
  - `@bounded-systems/prx` — `execWorktrunk`, `runClaudePreflight`, and
    `runHookVerb`/`readStdin` gain optional injectable spawn/exec/stdin seams
    (default to the real implementations) so their subprocess/stdin boundaries
    are unit-testable.
