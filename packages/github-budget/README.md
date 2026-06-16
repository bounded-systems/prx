# @bounded-systems/github-budget

A rate-limit-aware wrapper around `gh`: it classifies each call into a budget
bucket, gates it before spending, and records an audit trail.

GitHub's API has several distinct rate limits (core, search, GraphQL, …). This
package classifies a call into its bucket, checks the remaining budget *before*
making it, and logs what was spent and why — so a long-running agent doesn't
blow a limit mid-task.

## Install

```sh
npm install @bounded-systems/github-budget @bounded-systems/audit-context @bounded-systems/env @bounded-systems/proc zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
// Classify, gate, and audit a gh call before it spends from its bucket.
// The pre-call gate consults the remaining budget for the call's bucket;
// the audit trail records the spend with attribution from audit-context.
```

## Design

- **Gate before spend.** Bucket classification + a pre-call check keep usage
  inside the limit rather than discovering the limit by hitting it.
- **Attributed audit.** Spends are recorded with the verb/actor attribution from
  `@bounded-systems/audit-context`. An extractability test enforces that
  `audit-context`, `env`, and `proc` are the only repo dependencies.

## License

[MIT](./LICENSE) © Bounded Systems
