# GitHub App: `bounded-systems-prx`

**Status:** Spec / app-as-code (prx-0qr, prx-h1e) · **Owner:** bounded-systems org · **Date:** 2026-06-04

The org-owned GitHub App that lets prx react to GitHub events and keep a Project
in sync. Its definition of record is the committed manifest
[`.github/prx-app.manifest.json`](../.github/prx-app.manifest.json) — app-as-code,
the same ethos as the capability policy and value props. The live app should be
reconciled to the manifest, not the other way around.

## Live facts

| | |
|---|---|
| **App** | `bounded-systems-prx` (org-owned) |
| **Settings** | `https://github.com/organizations/bounded-systems/settings/apps/bounded-systems-prx` |
| **Owner** | `bounded-systems` (org) — not a personal account |
| **Install target** | Only on `@bounded-systems` (`public: false`) |
| **Installation ID** | `138039680` (on the `bounded-systems` org) |
| **Homepage** | `https://bounded.tools` |
| **Webhook** | `https://bounded.tools/api/github/webhooks` (active, secret) |
| **Setup URL** | `https://bounded.tools/setup` |

`installation_id 138039680` is the handle prx authenticates through: App ID +
private key → JWT → `POST /app/installations/138039680/access_tokens` → a
short-lived installation token. Every webhook delivery carries `installation.id`,
so the receiver looks up which installation/token to use.

## Architecture (where the code lives)

- **This repo (prx)** owns the **app definition** (the manifest) and the actor
  model the permissions serve.
- The **webhook receiver + the `/setup` endpoint** are built in the **separate
  `bounded.tools` repo**, NOT here.
- **Future mode:** webhook → forward to a **local** prx (webhook-to-local) for
  dev. Not built yet.

## Permissions & events (the manifest, annotated)

**Repository permissions**
- `metadata: read` — mandatory.
- `contents: read` — read the tree/commits. (Bump to `write` only if the app
  itself commits/merges; keeper pushes via git, so read is usually enough.)
- `issues: write` — intake/triage write issue bodies, labels, comments.
- `pull_requests: write` — open / review / merge PRs (forge).
- `checks: read` — gate on CI. (Bump to `write` only if prx publishes its
  `checks/v1` as GitHub check runs.)

**Organization permissions**
- `organization_projects: write` — Projects v2 sync (**prx-h1e**). This is the
  org-level grant the *user* installation could never hold.

**Account permissions**
- `git_ssh_signing_keys: write` — **planned, currently inert** (**prx-dqf**). The
  intent: register/rotate **keeper's** GitHub SSH *signing* key (the same per-actor
  ed25519 key keymaker derives) so keeper's commits show **Verified** under its own
  identity. Account permissions only activate via the **user-auth flow** (OAuth /
  Device Flow), which is currently **off**, and they manage *a user account's*
  keys — so this needs (1) a keeper bot account, (2) the user-auth flow re-enabled,
  (3) a keymaker-key → SSH-signing-key export. Kept in the manifest because the
  value is programmatic rotation; remove from both manifest and live app together
  if prx-dqf is dropped.

**Events** (`prx-0qr`): `issues`, `pull_request`, `pull_request_review`,
`check_suite`, `projects_v2_item`, `meta`.

**User-identity flows:** all OFF (no Callback URL, no OAuth-on-install, no Device
Flow). Re-enable only for a `bounded.tools` / CLI sign-in — or for prx-dqf.

## Recreating the app from the manifest (app-as-code flow)

GitHub can create the App from the manifest so its config is reproducible:

1. POST the manifest to
   `https://github.com/organizations/bounded-systems/settings/apps/new` as the
   `manifest` form parameter (a tiny HTML form that submits the JSON).
2. GitHub creates the App and redirects to `redirect_url` with `?code=<code>`.
3. Exchange once: `POST /app-manifests/{code}/conversions` → returns the **App
   ID**, **`pem` private key**, **`webhook_secret`**, and client secret.
4. Store those as deployment secrets (below) and install on the org.

This is how you'd stand up a clean app for a fresh org or recover from a deletion
without re-clicking the form.

## Secrets

The `installation_id` and App ID are identifiers (fine to commit/log). The
**private key (`.pem`)**, **webhook secret**, and **client secret** are real
secrets — keep them in sops/agenix / env, never in the repo, mirroring the
keymaker deployment-master pattern. Even with user-identity flows currently OFF,
treat the client secret as sensitive credential material (store/rotate like other
secrets if those flows are ever enabled). The manifest deliberately contains **no**
secret (the webhook secret is minted by the conversion step, not stored here).

## Related beads

- **prx-0qr** — webhook receiver + setup endpoint (in the `bounded.tools` repo);
  webhook-to-local dev mode.
- **prx-h1e** — Projects v2 board synced from beads.
- **prx-dqf** — keeper's own GitHub SSH signing key (keymaker ed25519 → Verified
  commits); the dependency that activates `git_ssh_signing_keys`.
