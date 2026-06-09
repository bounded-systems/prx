# prx — project roadmap

> The strategic roadmap for turning the `@prx/*` substrate inside `ai-home` into
> **prx**: a family of standalone, content-addressed, contract-mediated modules,
> each its own public repo under a GitHub **org**, with `ai-home` staying private
> as personal AI setups that *consume* the public packages. Sits above the live
> registries — it sequences them, it does not replace them:
> `docs/companion-repos.md` (extraction registry, epic #693),
> `docs/handoffs/anchored-chain-roadmap.md` (provenance), and
> `docs/architecture/standalone-modules.md` (decomposition litmus). Written 2026-05-26.

## End-state (the vision)

- **prx** = the public substrate: each module its own repo under a GitHub org,
  published under one npm scope, depended on outward-only, eventually
  contract-mediated (the no-ambient-authority end-state of
  `standalone-modules.md`).
- **ai-home** = private "AI setups": personal orchestration + config that
  consumes the published prx packages as ordinary dependencies. Whatever in
  `src/` is general becomes a prx module (public); whatever is personal glue
  stays here (private).

## Where we are

- **18 packages** under `packages/`, **15 with extractability tests** enforcing
  outward-only deps; resolved via bun `workspaces` + `tsconfig` paths.
- **Clean dependency DAG — no cycles** (verified; the apparent `proc ↔ policy`
  edge is a comment, not an import). Leaf-first extraction works without
  untangling.
- **anchored-chain** already passes the standalone litmus; `surface-sync`
  (Stage 1) and `scout` are in flight (`standalone-modules.md`).
- An extraction epic (#693) + `companion-repos.md` already exist, using
  `git subtree split` to publish with history. **Targets are currently
  `bdelanghe/*` (personal) — this roadmap retargets them to the org.**

## The "safe to publish" gate (per-repo definition of done)

A module is publishable only when:

1. **No secrets** in code *or git history* — secret-scan the `subtree split`
   output; scrub before first push (one-way; do it right).
2. **Outward-only deps** — extractability test green; zero import into the
   private monolith.
3. **Stands alone in CI** — builds/tests without `ai-home`'s harness.
4. **No private-infra coupling** — no hardcoded internal hosts/paths/org
   assumptions.
5. **License + README + provenance** — license chosen (M0); once Track A lands,
   published artifacts carry SLSA/DSSE attestations.

## Foundation — M0: the GitHub org + npm scope

The org is the home for every per-module repo; stand it up first.

- **Create the org.** *"A business or institution"* if it will host
  teams/multiple maintainers; *"personal"* is fine for solo. (See **Open
  decisions** — the name `prx` is already taken on GitHub.)
- **Claim the npm scope.** Keep **GitHub org name == npm scope** for brand
  cohesion (avoid `@scopeA/pkg` living at `github.com/orgB`). If `@prx` is
  unavailable on npm, align the scope to the chosen org name and rename the
  packages' `@prx/*` → `@<scope>/*` in one sweep.
- **Org defaults:** default-private repos, branch protection, required signed
  commits (ties to Track A), a shared CI/release template, CODEOWNERS.
- **Retarget** `companion-repos.md`'s `bdelanghe/*` targets to `<org>/*`.

## Workstreams

### Track A — anchored-chain provenance *(in flight)*
Phase A (SLSA emission) → 1.5 (Sigstore) → B (contracts as materials) → 2
(prune bespoke format) → enforcement → 3 (Moon). Full detail + entry points:
`docs/handoffs/anchored-chain-roadmap.md` and the two spikes. **Relevance to the
org:** signed provenance *is* part of "safe to publish" — published artifacts
become independently verifiable, and "required signed commits" is an org default.

### Track B — decompose the pr-state monolith *(in flight)*
Per `standalone-modules.md`: extract the pure `surface-sync` transform (in place
→ `src/surface-sync/`) → make `scout` the board reader → `scout` standalone →
`github.ts` becomes a **state service behind a contract**. This is the
*precondition* for extracting the `src/`-resident modules (vs the `packages/`
ones, which are already split-ready).

### Track C — public per-module repo split *(the new goal)*
1. **M0** — org + scope + publishing template proven on **one leaf** (e.g.
   `cas` or `env`).
2. **Extract leaf-first**, in waves (the `@prx` packages are already
   split-ready via the extractability tests):
   - **Wave 0 (leaves):** `cas`, `env`, `disposition`, `audit-context`,
     `machine-schema`, `prx-config`, `policy`
   - **Wave 1:** `proc`, `auth`, `anchored-chain`, `surface-sync`
   - **Wave 2:** `github-budget`, `anchored-chain-sqlite`, `bd`, `git`
   - **Wave 3:** `gh`, `scout`
   - **Then** the Track-B `src/` modules (`fetch`, `surface-sync` runtime,
     `scout`) once they land as packages.
3. **Flip consumption** — `ai-home` moves each extracted package from
   `workspace:*` to the published version; delete the in-repo `packages/` copy
   once consumed. *(Riskiest step — stage it package-by-package, leaf-first.)*
4. `ai-home` ends as the private AI-setups consumer of public prx.

## Milestones (sequenced)

| M | Goal | Exit criterion |
|---|---|---|
| **M0** | Org + npm scope + release template | Org exists; one leaf published from `<org>/<pkg>`; `ai-home` consumes it published |
| **M1** | Wave 0 leaves extracted | All leaf packages live under the org + published; `ai-home` consumes them |
| **M2** | Waves 1–3 (`@prx` substrate) extracted | `packages/` removed from `ai-home`; all deps consumed as published |
| **M3** | Track A enforcement on | Published artifacts carry verifiable SLSA/DSSE; `requireSigned` enforced |
| **M4** | Track B `src/` modules extracted | `surface-sync`, `scout`, `fetch` are public repos |
| **M5** | `github.ts` as contract-mediated service | Callers speak a contract, not an import; `ai-home` is private orchestration/config only |

Tracks A and B run **in parallel** with C's early waves; C-step-3 (consumption
flip) gates on each module clearing the publish gate. The existing epic-#693
extraction milestones (workspace conversion → Python→TS ports → `subtree split`
publish) are the *mechanics* under M1–M2 — retargeted to the org.

## Open decisions

- **Org name (blocking M0):** `prx` is taken on GitHub. Candidates that keep the
  brand: `prx-dev`, `prxhq`, `getprx`, `useprx`, `prx-sh`, `prxlabs`,
  `prx-tools`. **Pick one whose npm scope is also free**, and decide
  personal-vs-business.
- **npm scope:** is `@prx` free on npm? If not, the org name and scope must
  agree (rename `@prx/*` accordingly).
- **Interim monorepo?** Repo-per-module is the chosen end-state, but a single
  public monorepo could be a faster M1 stepping stone (fewer release pipelines
  up front) before fanning out — decide whether the overhead of N repos is worth
  paying immediately.
- **License:** MIT vs Apache-2.0 (Apache adds an explicit patent grant).
- **Public boundary of `src/`:** which decomposed orchestration goes public
  (Track B output) vs stays private in `ai-home`.

## References

- `docs/companion-repos.md` — live extraction registry + `subtree split`
  mechanics (epic #693). **Retarget to org.**
- `docs/handoffs/anchored-chain-roadmap.md` + `docs/spikes/{sigstore-dsse-signing,slsa-provenance-emission}.md` — Track A.
- `docs/architecture/standalone-modules.md`, `surface-sync-extraction.md` — Track B.
- `docs/anchored-chain/in-toto-alignment-plan.md` — the provenance ADR.
