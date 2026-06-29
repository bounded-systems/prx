# ADR — GitHub Apps: permission-bucketed apps + per-use attenuation

> **Status: design.** Supersedes the single-app framing in
> [docs/github-app.md](../github-app.md) (the `bounded-systems-prx` operational
> doc). Pairs with the runtime broker (`packages/prx/src/github-app/*`) and the
> `ghappd` credential-broker door ([GHAPPD.md in claude-box], `src/ghappd/*`).

## Context — what exists today

Three GitHub-App credential families are in use, but only one is app-as-code:

| credential | secrets | used by | scopes |
|---|---|---|---|
| **bounded-systems-prx** | `PRX_GH_APP_*` (runtime); `FRONT_DESK_CLIENT_ID` + `FRONT_DESK_APP_PRIVATE_KEY` (CI add-to-project — **legacy name for the SAME app**) | broker/ghappd (runtime) + `front-desk-add.yml` (CI) | union: `contents`/`issues`/`pull_requests`/`checks` + `organization_projects:write` + `git_ssh_signing_keys:write` (inert, prx-dqf) |
| **Changesets** | `CHANGESETS_APP_*` | `version.yml` (push release branch + open PR) | `contents` + `pull_requests` write |

Problems:
1. **One app holds the union of all scopes.** A leak of the `bounded-systems-prx` PEM exposes forge + org-projects + signing at once.
2. **Runtime↔CI split.** The runtime broker reads `PRX_GH_APP_*`; CI mints `FRONT_DESK_*`/`CHANGESETS_*` *inline* via `create-github-app-token`, bypassing the broker. No shared credential identity or config surface.
3. **Only `bounded-systems-prx` is app-as-code** (`.github/prx-app.manifest.json`); Front Desk/Changesets scopes live only in workflow comments.
4. **Front Desk is the same registration** as `bounded-systems-prx` under a legacy secret name (confirmed) — duplicate naming, not a separate app.

## Decision — bucketed apps + per-use attenuation (two layers of least privilege)

**A small set of GitHub Apps, each holding one coherent PERMISSION BUCKET; every minted token further ATTENUATED to the consumer's exact need.**

- **Layer 1 — app buckets (key blast-radius).** Each app's PEM grants only its bucket's scopes. A leaked key compromises one bucket, not the union.
- **Layer 2 — per-use attenuation (token blast-radius).** The broker/door mints each installation token narrowed to the caller's repos + a subset of the bucket's permissions (`PRX_GH_APP_REPOSITORIES` / `PRX_GH_APP_PERMISSIONS`, already built). Even within a bucket, a consumer gets the minimum.

### The buckets

| app | permissions | consumers |
|---|---|---|
| **prx-forge** | `contents`, `issues`, `pull_requests`, `checks` (write) | agents/PR ops, `version.yml` (changesets folds in here — its scope ⊆ forge) |
| **prx-projects** | `organization_projects: write` (+ issues/PRs read) | `front-desk-add.yml` (the org-level grant a user install can't hold) |

(`metadata: read` on all.) The current union manifest splits into these **two** installation-token buckets.

> **Not a bucket: keeper SSH signing.** Originally sketched as a `prx-signing`
> bucket (`git_ssh_signing_keys: write`), but that permission is a **user/account**
> scope — it applies to the authorizing user via the user-to-server OAuth flow, not
> an installation `default_permissions`. Confirmed empirically: the live
> `bounded-systems-prx` app never held it despite its manifest declaring it, and the
> App-manifest flow rejects it as an installation permission. So keeper SSH signing
> is a **user-auth** concern (a keeper bot account authorizes the app; keymaker
> exports the signing key) tracked under **prx-dqf** — it does not fit the
> installation-token bucket model and gets no installation app.

### Consumption — two surfaces, the SAME apps

- **Runtime** (agents / local / pod): a `ghappd`-shaped **credential door per bucket app** — `forge-d` / `projects-d` — each holding that bucket's PEM and leasing per-use attenuated installation tokens. A room grants only the bucket-doors it needs (DOORS.md: a door is one kind of access → a bucket *is* a door). This **generalizes the `ghappd` we built** (parameterize by bucket; `door-source.ts` already dials a door by endpoint — extend to per-bucket endpoints).
- **CI** (Actions): `create-github-app-token` with the **bucket app per job** (forge for `version.yml`, projects for `front-desk-add`), attenuated via the action's `repositories`/`permission-*` inputs. Same registrations as runtime — no CI-only apps.

### Naming & secrets

Unify on a per-bucket convention, dropping the legacy names:
- CI/secret families: `PRX_FORGE_APP_*`, `PRX_PROJECTS_APP_*`, `PRX_SIGNING_APP_*` (id + private key).
- Runtime door endpoints: `PRX_FORGE_DOOR`, `PRX_PROJECTS_DOOR`, `PRX_SIGNING_DOOR` (the broker's `PRX_GH_APP_DOOR` generalizes).
- Retire `FRONT_DESK_*` (→ prx-projects) and `CHANGESETS_*` (→ prx-forge).
- De-hardcode the installation id (currently `138039680` in `broker-config.ts:13`) — each bucket app has its own installation.

## Threat model

- **App-key leak** → one bucket's scopes (not the union).
- **Minted-token leak** → ≤1h, attenuated to the caller's repos + a permission subset.
- **PEMs live behind the doors** (ghappd pattern: `PRX_GH_APP_KEY_FILE` → tmpfs mount; never in agent env/argv/image layer).
- Every lease is an auditable door event (trust-ledger fit).

## Alternatives considered

- **One union app + attenuation only** — simplest to manage, but a key leak = full union scope. Rejected: no blast-radius bucketing (this is roughly today's state).
- **One app per fine-grained permission** — maximal isolation, but unmanageable registration/key sprawl. Rejected.
- **Bucketed (this ADR)** — the middle: coarse blast-radius isolation at the key, fine least-privilege at the token.

## Migration (phased, each independently shippable)

1. **Unify naming now.** Front Desk == bounded-systems-prx → point `front-desk-add.yml` (and `version.yml`'s changesets mint) at the unified app's secrets; this is an interim single (union) app, but stops the duplicate-name confusion.
2. **Author bucket manifests** as app-as-code (`.github/apps/{forge,projects}.manifest.json`); split `.github/prx-app.manifest.json`. (No signing manifest — see the note above.)
3. **Register/split the apps**, install on `@bounded-systems`, store PEMs in agenix/sops (never in repo).
4. **Runtime**: generalize `ghappd` into a per-bucket door; `door-source`/`apply` select the door by requested capability; rooms grant the bucket-doors they need.
5. **CI**: switch each workflow to its bucket app via `create-github-app-token` with per-job attenuation.
6. **Retire** `FRONT_DESK_*` / `CHANGESETS_*`; de-hardcode installation ids.

## Open

- **[DECISION] Door topology** — one multi-key door (`lease(bucket, attenuation)`) vs one door per bucket app (`forge-d`/`projects-d`). Recommend **per-bucket doors** (matches DOORS.md "one door = one kind of access"; a room grants exactly the buckets it needs).
- **[RESOLVED]** Front Desk == bounded-systems-prx (legacy secret name).

Relates: `ghappd` (the first bucket door — likely `forge-d`), GHAPPD.md, AUTHD.md (sibling token-lease door), prx-cdln (ghappd build), prx-z6ru (operational deploy), prx-dqf (signing scope), prx-6194/prx-9s14 (credential-broker doors).
