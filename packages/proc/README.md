# @bounded-systems/proc

The one allowed subprocess spawn point — every external-tool invocation routes
through this capability.

Nothing in prx calls `node:child_process` directly. They go through a
`CommandRunner`, so spawning is policy-checked (via `@bounded-systems/policy`),
capturable, and substitutable in tests. The result is that the set of external
commands a program can run is enumerable and gated, not scattered.

## Install

```sh
npm install @bounded-systems/proc @bounded-systems/env @bounded-systems/policy zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
import {
  defaultRunner,
  runCaptured,
  type CommandRunner,
  type CommandResult,
  type RunOptions,
} from "@bounded-systems/proc";

// Depend on the runner port; default to the real one.
async function gitStatus(run: CommandRunner = defaultRunner) {
  const res: CommandResult = await runCaptured(run, "git", ["status", "--porcelain"]);
  return res.stdout;
}
```

## Design

- **Single spawn point.** All subprocess execution flows through a
  `CommandRunner`, so it can be policy-gated and mocked. `node:child_process`
  lives here and nowhere else.
- **Policy-aware.** Cacheability and read-only classification derive from
  `@bounded-systems/policy`. An extractability test enforces that `env` and
  `policy` are the only repo dependencies.

## License

[MIT](./LICENSE) © Bounded Systems
