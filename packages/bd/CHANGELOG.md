# @bounded-systems/bd

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
