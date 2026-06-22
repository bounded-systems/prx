# Companion repo inventory

> Extraction registry for the ai-home → prx + companion-packages refactor.
> Parent epic: [#693](https://github.com/bdelanghe/ai-home/issues/693).
> Design details: beads `ai-home-anpx`.
>
> Update the Status column as each package leaves ai-home.

## Candidates

| Package | Current path in ai-home | Target repo | Existing repo? | Status |
|---|---|---|---|---|
| cas | `packages/cas/` (SHA-256 CAS substrate + blob-store port) — bottom of the provenance stack, zero internal deps | `bounded-systems/cas` | **yes** | **extracted** (2026-06-22) — own repo, history, CI, JSR re-linked |
| machine-schema | `src/machine/state.ts` (266 LOC) + branded id types | `bounded-systems/machine-schema` | **yes** | **extracted** (2026-06-22) — own repo, history, CI, JSR re-linked |
| pr-contract | `skills/pr-contract/` (Python scripts + schema + templates) | `bounded-systems/pr-contract` | no (unrelated: `bdelanghe/dev-contracts*`) | not-started |
| safe-exec | `scripts/{git,gh,wt,bd,prx}-safe` + `scripts/tool-policy.sh` | `bounded-systems/safe-exec` | no | not-started |
| gh-state-reader | `src/pr-state/github.ts` (5,419 LOC, 139 exports) | `bounded-systems/gh-state-reader` | no | not-started |
| runtime-profile | `src/machine/runtime_profiles.ts` (578 LOC) | `bounded-systems/runtime-profile` | no | not-started |

> **Targets retargeted to the `bounded-systems` org** (npm scope `@bounded-systems/*`,
> GitHub org `github.com/bounded-systems`) per `docs/roadmap/prx.md` Track C.
> `cas` was the M0 leaf-first pilot: it proved the extraction template (subtree
> split with history → standalone tsconfig + CI gate + OIDC publish workflow →
> JSR re-link) that every leaf reuses.

> [!IMPORTANT]
> **Update 2026-06-22 — the "consume-back flip" is moot (satisfied by removal).**
> The roadmap's M0 exit assumed `ai-home` would *consume the published package as
> a library dependency*. That premise no longer holds: `ai-home` contains **no
> code that imports any `@bounded-systems/*` package** — it depends on prx only as
> a **Nix flake input** (`prx.url = "github:bounded-systems/prx"`), not on the
> libs. The TypeScript that once used these packages already moved wholesale into
> the prx monorepo, so there is nothing left in `ai-home` to "flip" from
> workspace → published. Wiring one would mean manufacturing a synthetic consumer.
> **Net:** publish + own-repo extraction is the real deliverable; consume-back is
> a no-op here. Don't re-chase it.
>
> **Extracted so far (own repo + history + CI + JSR re-linked to it):** the clean
> leaves — `verbspec`, `cas`, `audit-context`, `disposition`, `env`, `fs`,
> `machine-schema`, `policy`. All still also build inside the monorepo (workspace);
> removal from `packages/*` is deferred (no consumer forces it).
> **Not extracted:** the 13 non-leaf packages (sibling deps → need consume-from-JSR
> setup in their standalone repos) and `prx-config` (a clean leaf, but gated:
> no external consumer — see `.github-private` `prx-config-extraction.md`).

Status values: `not-started` → `in-progress` → `extracted`.

## skills/.system/ decision

**Verdict (updated M2.5): deleted.**

`skills/.system/` was 1,160 lines of upstream Anthropic skill tooling
(`skill-creator/`, `skill-installer/`), referenced by nothing under ai-home
(grep-verified). The original plan was to vendor it as-is and allowlist its
python. Superseded by the operator's "no python in this repo" directive (M2.5,
GH-696): rather than allowlist, the two skills were **removed entirely** (the
capability was unused; recoverable from git history / upstream if needed). The
M2 invariant is now "zero `.py`", enforced by `test/no-operational-python.test.ts`
(a `bun test`, since `flake.nix` has no `checks`/nixpkgs infrastructure).

## How this file gets used

- M1 flips nothing here (workspace conversion is in-tree).
- M2 flips `pr-contract` to `in-progress` when the Python scripts are being ported to TS under `packages/pr-contract/`.
- M3 flips each row to `extracted` as `git subtree split` publishes the repo. Order: pr-contract → machine-schema → safe-exec → runtime-profile → gh-state-reader.
- M4/M5/M6 do not touch this file.
