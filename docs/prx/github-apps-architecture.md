# ADR — GitHub Apps: permission-bucketed apps + per-use attenuation

> **Status: design (partially superseded).** Supersedes the single-app framing in
> [docs/github-app.md](../github-app.md) (the `bounded-systems-prx` operational
> doc). Pairs with the runtime broker (`packages/prx/src/github-app/*`) and the
> `ghappd` credential-broker door ([GHAPPD.md in claude-box], `src/ghappd/*`).
>
> **UPDATE (prx-26bq, 2026-06-29) — the `prx-projects` bucket is retired.** The
> `organization_projects` / front-desk-add path is now served by the deployed
> **cf-token-broker** (a Cloudflare Worker — the org-wide OIDC GitHub-App token
> broker), not a dedicated bucket app. Every Front Desk consumer —
> `front-desk-sync`, all `front-desk-add` workflows, and the cross-repo
> `notify-front-desk → trigger-sync` chain — mints a least-privilege installation
> token from the broker over GitHub Actions OIDC; the App key lives only in the
> broker. The `prx-projects` app's secret/var (`PRX_PROJECTS_APP_*`) are deleted,
> and its registration can be uninstalled. **This ADR's remaining live scope is the
> `prx-forge` bucket (agents / `version.yml`) + the runtime `ghappd` doors.**
> `prx-projects` rows below are kept for history and marked retired.

## Context — what exists today

Three GitHub-App credential families are in use, but only one is app-as-code:

| credential | secrets | used by | scopes |
|---|---|---|---|
| **bounded-systems-prx** (a.k.a. the broker's `front-desk` app) | `PRX_GH_APP_*` (runtime); ~~`FRONT_DESK_*` (CI)~~ — **deleted (prx-26bq)**; CI now mints via the cf-token-broker over OIDC | broker/ghappd (runtime) + cf-token-broker `front-desk` app (all front-desk CI) | union: `contents`/`issues`/`pull_requests`/`checks` + `organization_projects:write` + `git_ssh_signing_keys:write` (inert, prx-dqf) |
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
| ~~**prx-projects**~~ *(retired — prx-26bq)* | `organization_projects: write` (+ issues/PRs read) | ~~`front-desk-add.yml`~~ → now the **cf-token-broker** `front-desk` app (OIDC; see the UPDATE above) |

(`metadata: read` on all.) The remaining live bucket is **prx-forge**; the
projects bucket is superseded by the cf-token-broker.

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
- **CI** (Actions): `version.yml` mints the **prx-forge** app via `create-github-app-token`, attenuated via the action's `repositories`/`permission-*` inputs. **Front Desk CI no longer uses a bucket app** — `front-desk-add` / the sync chain mint the `front-desk` app from the **cf-token-broker** over OIDC (prx-26bq), so no App key reaches the runner.

### Naming & secrets

Unify on a per-bucket convention, dropping the legacy names:
- CI/secret families: `PRX_FORGE_APP_*` (id + private key). ~~`PRX_PROJECTS_APP_*`~~ **deleted (prx-26bq)** — the projects path is brokered, no repo secret. ~~`PRX_SIGNING_APP_*`~~ not a bucket (see note).
- Runtime door endpoints: `PRX_FORGE_DOOR` (the broker's `PRX_GH_APP_DOOR` generalizes). No `PRX_PROJECTS_DOOR` — projects is served by the cf-token-broker, not a runtime bucket door.
- `FRONT_DESK_*` org secrets — **deleted (prx-26bq)**; the front-desk path is OIDC-brokered. `CHANGESETS_*` → folds into `prx-forge`.
- De-hardcode the installation id (currently `138039680` in `broker-config.ts:13`) — the forge bucket has its own installation.

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

> The **projects / front-desk path is done** — but via the **cf-token-broker**
> (prx-26bq), not a `prx-projects` bucket. The phases below now apply only to the
> **prx-forge** bucket + runtime doors.

1. ~~**Unify naming.**~~ Done — Front Desk == bounded-systems-prx (confirmed); the front-desk CI path is now OIDC-brokered.
2. **Author the prx-forge manifest** as app-as-code; split `.github/prx-app.manifest.json`. (No projects manifest — brokered; no signing manifest — see the note above.)
3. **Register/split prx-forge**, install on `@bounded-systems`, store the PEM in agenix/sops (never in repo).
4. **Runtime**: generalize `ghappd` into the `forge-d` bucket door; `door-source`/`apply` select by capability; rooms grant the door they need.
5. **CI**: switch `version.yml` to the prx-forge app via `create-github-app-token` with per-job attenuation. (front-desk-add is already brokered.)
6. **Retire** `CHANGESETS_*` (→ prx-forge); de-hardcode the installation id. (`FRONT_DESK_*` / `PRX_PROJECTS_*` already deleted in prx-26bq.)

## Open

- **[DECISION] Door topology** — one multi-key door (`lease(bucket, attenuation)`) vs one door per bucket app (`forge-d`/`projects-d`). Recommend **per-bucket doors** (matches DOORS.md "one door = one kind of access"; a room grants exactly the buckets it needs).
- **[RESOLVED]** Front Desk == bounded-systems-prx (legacy secret name).

Relates: **prx-26bq** (cf-token-broker — supersedes the projects bucket), `ghappd` (the first bucket door — likely `forge-d`), GHAPPD.md, AUTHD.md (sibling token-lease door), prx-cdln (ghappd build), prx-z6ru (operational deploy), prx-dqf (signing scope), prx-6194/prx-9s14 (credential-broker doors).
