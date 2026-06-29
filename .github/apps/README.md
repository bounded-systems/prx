# GitHub App manifests — permission buckets

App-as-code manifests for prx's permission-**bucketed** GitHub Apps
(spec: [docs/prx/github-apps-architecture.md](../../docs/prx/github-apps-architecture.md)).
Each app holds one coherent permission bucket (coarse least-privilege / key
blast-radius); the broker/ghappd door attenuates each minted token per use (fine
least-privilege). These are the **def-of-record** to register the apps from
(POST the manifest → conversion → App ID / pem / secrets in agenix/sops); the
live apps are reconciled *to* these files.

| manifest | bucket | replaces |
|---|---|---|
| `prx-forge.manifest.json` | contents/issues/PRs/checks | `CHANGESETS_*` (folds in) |
| `prx-projects.manifest.json` | organization_projects | `FRONT_DESK_*` |

> **No prx-signing bucket.** `git_ssh_signing_keys` is a **user/account** permission
> (applies to the authorizing user via the user-to-server OAuth flow), **not** an
> installation `default_permissions` scope — confirmed: the live `bounded-systems-prx`
> app never held it despite its manifest declaring it, and the manifest flow rejects
> it. Keeper SSH signing is therefore a **user-auth** concern (a keeper bot account
> authorizes the app), tracked under **prx-dqf** — not an installation-token bucket.

The union app `../prx-app.manifest.json` (`bounded-systems-prx`) stays as the
def-of-record until the buckets are registered and CI/runtime cut over
(migration: prx-zee7).

## Registered (Phase 3, non-secret identifiers)

| app | app_id | installation_id | status |
|---|---|---|---|
| `prx-forge` | 4169313 | 143190928 | created + installed (all repos) |
| `prx-projects` | 4169314 | 143190950 | created + installed (all repos) |
| ~~`prx-signing`~~ | — | — | **dropped as a bucket** — `git_ssh_signing_keys` is a user-auth permission, not an installation scope (prx-dqf) |

Caveats:
- **`prx-forge` live app still grants `contents:read`.** This manifest now declares
  `contents:write` (needed to push the changeset release branch and merge PRs). Bump
  the live app's permission in its settings → installations re-accept, to match.
- PEMs / client secrets / webhook secrets are **not** in this repo — agenix/sops.
  CI reads `vars.PRX_FORGE_APP_ID` + `secrets.PRX_FORGE_APP_PRIVATE_KEY` (and the
  `PRX_PROJECTS_*` pair); runtime reads `PRX_GH_APP_*` / the bucket door endpoints.
