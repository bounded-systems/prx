# @bounded-systems/host

The one sanctioned reader of host/OS ambient state — home directory, temp
directory, hostname — routed through a capability rather than read ad hoc.

Like `@bounded-systems/env` for the environment, this is the single place that
reaches for machine-level ambient values, so they're enumerable and a test can
substitute them.

## Install

```sh
npm install @bounded-systems/host @bounded-systems/env
```

## Usage

```ts
import { homeDir, tmpDir, hostName } from "@bounded-systems/host";

const home = homeDir();
const tmp = tmpDir();
const name = hostName();
```

## Design

- **One access point.** Host/OS ambient reads go through here, so machine
  dependencies are discoverable and mockable.
- **Reads through `@bounded-systems/env`.** Where host state is configurable, it
  flows through the sanctioned env capability. An extractability test enforces
  `env` as the only repo dependency and no other ambient authority.

## License

[MIT](./LICENSE) © Bounded Systems
