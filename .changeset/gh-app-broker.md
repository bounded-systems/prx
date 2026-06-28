---
"@bounded-systems/prx": minor
---

Add the GitHub App token broker: mint a short-lived installation token at startup and publish it as `GH_TOKEN`, so prx's GitHub ops run headless on the app's own (higher) rate-limit pool with a bot identity — no interactive `gh auth login`.

- **src/github-app/broker-config.ts** — `resolveBrokerConfig()`: fail-open (null when unconfigured); PEM precedence inline `PRX_GH_APP_PRIVATE_KEY` (cloud-agent shape) > `PRX_GH_APP_KEY_FILE` (path, read via injected `readFile`); throws on misconfig.
- **src/github-app/broker.ts** — `createBroker()`: per-process cache + expiry-aware re-mint + concurrent-dedupe around `mintInstallationToken`.
- **src/github-app/apply.ts** — `applyBrokeredGhToken()`: precedence `GH_TOKEN`/`GITHUB_TOKEN` already set (CI) > broker-minted > personal `gh` (fail-open). Writes via `@bounded-systems/env` (ambient-authority guard). Fail-closed only when configured-but-mint-fails. `getProcessBroker()` lets daemons refresh.
- **scripts/pr_state.ts** — startup hook (owns the `node:fs` PEM read so `src/` stays fs-free).
- **nix/hm-module.nix** — `programs.prx.githubApp.{enable, clientId, privateKeyFile, installationId}`; emits path/ids only, never the PEM (the inline env var is the cloud-agent-only path).

Works headless in Claude Code cloud agents (inject the App key as the `PRX_GH_APP_PRIVATE_KEY` env secret); self-hosted OCI uses the file path via a podman secret. Builds on the `mintInstallationToken` primitive.
