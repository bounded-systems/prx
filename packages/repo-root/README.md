# @bounded-systems/repo-root

The repo-root resolution capability — the one sanctioned place that answers
"where is the root of this repository?"

Two modes: a lazy, git-based resolver for runtime (asks git for the toplevel,
via `@bounded-systems/proc`), and an eager `.git`-marker directory walk for
build/codegen contexts where spawning git isn't appropriate.

## Install

```sh
npm install @bounded-systems/repo-root @bounded-systems/proc
```

## Usage

```ts
import { repoRoot, repoRootEager } from "@bounded-systems/repo-root";

const root = await repoRoot();   // runtime: git rev-parse --show-toplevel, falls back to cwd
const buildRoot = repoRootEager(); // build/codegen: walk up to the .git marker, no subprocess
```

## Design

- **One resolution point.** Root discovery lives here, not scattered across
  callers, so the policy (git vs marker-walk, fallback behavior) is in one place.
- **Runtime git access via `@bounded-systems/proc`.** The lazy resolver spawns
  git only through the sanctioned subprocess capability. An extractability test
  enforces `proc` as the only repo dependency.

## License

[MIT](./LICENSE) © Bounded Systems
