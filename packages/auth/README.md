# @bounded-systems/auth

A service-credential resolver — the single sanctioned access point for the
tokens prx uses to reach GitHub and Notion.

Rather than read credentials from the environment at each call site, code asks
this resolver for a named service's token. Credential lookup lives in one place,
so the surface that touches secrets is small and auditable.

## Install

```sh
npm install @bounded-systems/auth @bounded-systems/env
```

## Usage

```ts
import { authToken, requireAuthToken, type AuthService } from "@bounded-systems/auth";

const gh = requireAuthToken("github");   // throws if unresolved
const notion = authToken("notion");      // string | undefined
```

## Design

- **One access point.** Every service credential is resolved here, so the
  secret-touching surface is enumerable.
- **Reads through `@bounded-systems/env`.** Ambient configuration flows through
  the sanctioned env capability, not raw `process.env`. An extractability test
  enforces that `env` is the only repo dependency and there's no other ambient
  authority.

## License

[MIT](./LICENSE) © Bounded Systems
