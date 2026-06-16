# @bounded-systems/gh

A wrapper around the GitHub CLI (`gh`) with policy enforcement, rate-limit
gating, and budget audit logging.

Every `gh` invocation routes through here: the subcommand is policy-checked, the
call is gated against its rate-limit budget (via `@bounded-systems/github-budget`),
and the spend is audit-logged. So GitHub access is authorized, bounded, and
accountable rather than scattered shell-outs.

## Install

```sh
npm install @bounded-systems/gh @bounded-systems/env @bounded-systems/proc @bounded-systems/policy @bounded-systems/github-budget
```

## Usage

```ts
// Policy-checked, budget-gated gh calls; the spend is recorded to the audit
// trail. The subcommand allowlist is enforced before the process is spawned.
```

## Design

- **One gated entry point.** Subcommand policy + rate-limit budget gating + audit
  logging wrap every `gh` call.
- **Spawns via `@bounded-systems/proc`.** External invocation goes through the
  sanctioned subprocess capability. An extractability test enforces the
  dependency set (`env`, `proc`, `policy`, `github-budget`).

## License

[MIT](./LICENSE) © Bounded Systems
