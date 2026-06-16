# @bounded-systems/policy

A tool-policy engine: which tool subcommands are allowed, given the current
state and the acting role.

The authority model is a table. A request names a **tool** (e.g. `git`, `gh`), a
**subcommand**, a **state**, and a **role**; the engine decides whether it's
allowed, blocked, or read-only, and can answer the inverse questions — which
subcommands a role may run, and which roles own a given capability.

## Install

```sh
npm install @bounded-systems/policy
```

## Usage

```ts
import {
  checkPolicy,
  isReadOnly,
  isBlocked,
  allowedSubcommands,
  ownersOf,
  POLICY_TOOLS,
  POLICY_ROLES,
} from "@bounded-systems/policy";

const decision = checkPolicy({ tool: "git", subcommand: "push", state, role });

isReadOnly("gh", "pr view");          // capability classification
allowedSubcommands("git", role);      // what this role may run
ownersOf("gh", "pr merge");           // which roles own this authority
```

## Design

- **Policy as data.** Allowlists are keyed by tool × state × role; decisions are
  pure lookups, so the same table answers "may I?" and "who may?".
- **Leaf package.** No repo dependencies and no ambient authority — an
  extractability test enforces it.

## License

[MIT](./LICENSE) © Bounded Systems
