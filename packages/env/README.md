# @bounded-systems/env

The one sanctioned reader of `process.env`.

Ambient configuration is authority. Rather than let any module reach into
`process.env` directly, prx routes every read through this single capability —
so the set of environment variables a program depends on is discoverable in one
place, and a test (or a sandbox) can substitute its own values without touching
the real environment.

## Install

```sh
npm install @bounded-systems/env
```

## Usage

```ts
import { getEnv, requireEnv, firstEnv, setEnv } from "@bounded-systems/env";

const home = getEnv("HOME");                 // string | undefined
const token = requireEnv("GITHUB_TOKEN");    // throws if unset
const ci = firstEnv("CI", "GITHUB_ACTIONS"); // first defined of several

// Test seams — scope an override, then restore.
setEnv("FEATURE_FLAG", "on");
```

`processEnv` returns the underlying record for the rare caller that needs it;
`setEnv`/`deleteEnv` exist for tests and tightly-scoped mutation.

## Design

- **Single access point.** Every `process.env` read in the codebase goes through
  here, so ambient dependencies are enumerable and mockable.
- **Leaf package.** No repo dependencies and no other ambient authority — an
  extractability test enforces it.

## License

[MIT](./LICENSE) © Bounded Systems
