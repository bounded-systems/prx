---
---

`publish-jsr` workflow generalised to publish any `@bounded-systems/*` package (workflow_dispatch `package` input + `@bounded-systems/*@*` tag trigger, env-injected + validated). Runtime-compat baked into the generated manifest (bun verified for all; cas = node/deno/bun). Tooling/CI only, no release.
