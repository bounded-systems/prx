---
"@bounded-systems/prx": patch
---

Add `scripts/gh-app-token-spike.ts` — de-risk minting a `bounded-systems-prx` GitHub App installation token locally.

Zero-dep Bun script (node:crypto + fetch): App ID/Client ID + private-key PEM →
signed RS256 JWT → `POST /app/installations/<id>/access_tokens` → installation
token → `GET /rate_limit` to prove the separate (higher) pool. The token is never
printed; it reports identity, scopes, and the rate-limit pools.

The spike before wiring a keymaker-style token broker so prx's GitHub ops run on
the app's quota (not the personal 5,000/hr that's easy to exhaust) with a bot
identity and least-privilege scopes (`.github/prx-app.manifest.json` is the
def-of-record). Credentials already exist for CI (FRONT_DESK_CLIENT_ID +
FRONT_DESK_APP_PRIVATE_KEY via actions/create-github-app-token); local use points
`PRX_GH_APP_KEY_FILE` at the key (ideally agenix/sops, path-only in env).
