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
| `prx-signing.manifest.json` | git_ssh_signing_keys (inert, prx-dqf) | — |

The union app `../prx-app.manifest.json` (`bounded-systems-prx`) stays as the
def-of-record until the buckets are registered and CI/runtime cut over
(migration: prx-zee7).
