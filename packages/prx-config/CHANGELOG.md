# @bounded-systems/prx-config

## 0.4.0

### Minor Changes

- 06a401d: Remove Warp TUI support (`tui_l2_warp.ts` and all `*Warp` exports). Package now only manages the L1 Claude TUI slice.

### Patch Changes

- 585be9c: Add explicit `z.ZodType<T>` annotations to exported Zod schemas for JSR fast-check compliance. Add `| undefined` to optional TypeScript type fields to match `exactOptionalPropertyTypes: true` + Zod optional output.
- 747b13f: Replace `z.infer<>` with explicit TypeScript types and add JSDoc to all exported symbols for JSR score 100.

## 0.2.1

### Patch Changes

- 45dc724: Author `bounded.{facet,role,domain}` (noun / config-schema / tui-config) so prx-config is a labeled node in the @bounded-systems registry knowledge graph. Metadata only.

## 0.2.0

### Minor Changes

- 2f4b731: Make the remaining leaf packages publish-ready as standalone packages.

  For each of `env`, `policy`, `disposition`, `audit-context`, `fs`, `machine-schema`, and `prx-config`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`.

  These are all true leaves (no internal `@bounded-systems` dependencies). Additionally:

  - `machine-schema` and `prx-config` gain the extractability test the other leaves already had.
  - `prx-config` now declares its `zod` peer dependency (it imported `zod` without declaring it).
