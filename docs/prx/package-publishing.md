# Publishing the `@bounded-systems/*` packages (JSR)

How the library packages get from this monorepo to consumers. The packages are
published to **[JSR](https://jsr.io)** directly from `prx` — no physical repo
split is required (and JSR publishes TypeScript source, so there's no dist
build in the publish path).

## Sources of truth

| Concern | Lives in | Maintained by |
| --- | --- | --- |
| Package version | `packages/<x>/package.json` `version` | changesets (`version-packages`) |
| JSR publish manifest | `packages/<x>/jsr.json` (`name`, `version`, `exports`) | mirrors package.json |
| Registry listing (description, repo link) | jsr.io, via `jsr-sync.ts` | the JSR management API |

`package.json` is the single source of version truth. `jsr.json` carries its own
`version` because `jsr publish` reads it — so the two **must** stay in lockstep.
`jsr-version-sync.ts` enforces that:

```sh
bun run jsr:versions:check   # CI guard — fails on drift
bun run jsr:versions         # rewrite jsr.json versions from package.json
```

`version-packages` runs the `--write` form, so a changeset release bumps both
files together. Wire `jsr:versions:check` into CI so a hand-edit can't reintroduce
drift.

## One-time setup (per scope/package)

1. Create the `@bounded-systems` scope on jsr.io.
2. Reserve each package name and link it to the publishing repo (authorises
   tokenless OIDC publishing):
   ```sh
   JSR_TOKEN=jsrp_… bun packages/prx/scripts/jsr-sync.ts        # --dry-run to preview
   ```
   `jsr-sync.ts` is idempotent: it creates missing packages and syncs each
   listing's description + GitHub link from this repo.

## Release flow

1. Author changesets as normal (`bun run changeset`).
2. `bun run version-packages` — bumps `package.json`, regenerates the changelog,
   **and** syncs `jsr.json` versions.
3. Merge the release PR; the release tags (`@bounded-systems/<pkg>@<version>`)
   trigger publishing.
4. `publish-jsr.yml` runs `bunx jsr publish` per package over tokenless OIDC
   (the GitHub OIDC token is exchanged for publish rights, verified against the
   package's linked repo — no secret).

> **Status:** `publish-jsr.yml` is currently scoped to the **`cas` pilot**
> (`working-directory: packages/cas`, tag `@bounded-systems/cas@*`). Generalise
> it to the full set with a matrix once the pilot has published cleanly — see
> "Generalising the workflow" below.

## Publish order (dependency waves)

JSR resolves inter-package deps at install time, so on a *first* publish each
wave's dependencies must already be live. The graph is acyclic:

```
wave 0  cas verbspec env policy disposition audit-context fs machine-schema prx-config
wave 1  anchored-chain(→cas)  auth(→env)  host(→env)  proc(→env,policy)  surface-sync(→disposition)
wave 2  anchored-chain-sqlite  repo-root  github-budget  bd  git
wave 3  gh  scout  slack
```

Once all names are reserved and published, ongoing releases don't need manual
ordering — only the initial bring-up does.

## Gotchas

- **Slow types.** JSR rejects public APIs whose types it can't infer without
  evaluation. If `jsr publish` fails on slow types, add explicit annotations to
  the package's public surface (preferred) or pass `--allow-slow-types`.
- **`anchored-chain-sqlite` is Bun-only.** It uses `bun:sqlite`,
  `drizzle-orm/bun-sqlite`, and `.sql`/`.json` import attributes. Set its
  `jsr.json` `runtimeCompat` accordingly and ensure consumers (`scout`, `slack`,
  `prx`) run on Bun. See GH-642.
- **Source-direct publish.** `jsr.json` `exports` point at `./src/index.ts`; the
  `dist` build (and the `bun`/`import` conditions in `package.json`) are for the
  npm consumption path, not JSR. `jsr.json` excludes `**/__tests__/**` and
  `dist/**` from the published tarball.

## Generalising the workflow beyond the cas pilot

Replace the single-package job with a matrix over the publishable packages
(those that carry a `jsr.json`), keyed off the release tag so each tag publishes
exactly its package. Keep `id-token: write` and the per-package
`working-directory`. The dependency-wave order above only matters for the first
publish; tag-driven publishes thereafter are independent.

## Appendix — physical repo extraction (optional)

JSR publishing does **not** require moving a package out of the monorepo. Extract
to a standalone `github.com/bounded-systems/<pkg>` repo only when a package needs
its own issue tracker / contributor surface. The dependency-ordered cut plan and
per-package steps live in
[GH-641](https://github.com/bounded-systems/prx/issues/641); the short version:
`git subtree split --prefix=packages/<pkg>` → push to the new repo → switch
`workspace:*` deps to published ranges → drop the package's `paths` entry from
the root `tsconfig.json` and its `packages/` dir from `prx`.
