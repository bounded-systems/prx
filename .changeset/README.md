# Changesets

This directory is managed by [changesets](https://github.com/changesets/changesets).
It is the release-tooling template proven on the `@bounded-systems/cas` leaf
(Track C / M0) and reused wholesale by the Wave 0–3 package extractions: a leaf
opts in by dropping `"private": true` from its `package.json` and adding publish
metadata — no tooling rework here.

Only **non-private** packages are versioned and published. Every package in this
repo is `"private": true` except the ones on the public-split path, so changesets
acts on exactly those.

## Workflow

1. **Add a changeset** for any change to a publishable package:

   ```sh
   bun run changeset
   ```

   This writes a markdown file here describing the bump (`patch` / `minor` /
   `major`) and the changelog entry. Commit it with your PR.

2. **Version** — consume the pending changesets, bump versions, and write
   `CHANGELOG.md` (run on the release branch / "Version Packages" PR):

   ```sh
   bun run version-packages
   ```

3. **Publish** — runs on merge to `main` via `.github/workflows/release.yml`.
   The workflow builds, runs each package's standalone gate, then:

   ```sh
   bun run release
   ```

   which publishes any package whose version is not yet on npm
   (`--provenance` is carried by each package's `publishConfig`).

The **first** publish of a package is seeded by setting its initial `version`
in `package.json` directly (e.g. `cas` starts at `0.1.0`); changesets drives
every bump after that.
