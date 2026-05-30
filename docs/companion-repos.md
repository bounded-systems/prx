# Companion repo inventory

> Extraction registry for the ai-home → prx + companion-packages refactor.
> Parent epic: [#693](https://github.com/bdelanghe/ai-home/issues/693).
> Design details: beads `ai-home-anpx`.
>
> Update the Status column as each package leaves ai-home.

## Candidates

| Package | Current path in ai-home | Target repo | Existing repo? | Status |
|---|---|---|---|---|
| cas | `packages/cas/` (SHA-256 CAS substrate + blob-store port) — bottom of the provenance stack, zero internal deps | `bounded-systems/cas` | no | M0 pilot — publish pipeline proven |
| machine-schema | `src/machine/state.ts` (266 LOC) + branded id types | `bounded-systems/machine-schema` | no | not-started |
| pr-contract | `skills/pr-contract/` (Python scripts + schema + templates) | `bounded-systems/pr-contract` | no (unrelated: `bdelanghe/dev-contracts*`) | not-started |
| safe-exec | `scripts/{git,gh,wt,bd,prx}-safe` + `scripts/tool-policy.sh` | `bounded-systems/safe-exec` | no | not-started |
| gh-state-reader | `src/pr-state/github.ts` (5,419 LOC, 139 exports) | `bounded-systems/gh-state-reader` | no | not-started |
| runtime-profile | `src/machine/runtime_profiles.ts` (578 LOC) | `bounded-systems/runtime-profile` | no | not-started |
| prx-mux | `packages/prx-mux/` (483 LOC, 3 src files + local runner) — already workspace-staged | `bounded-systems/prx-mux` | no | in-progress |

> **Targets retargeted to the `bounded-systems` org** (npm scope `@bounded-systems/*`,
> GitHub org `github.com/bounded-systems`) per `docs/roadmap/prx.md` Track C.
> `cas` is the M0 leaf-first pilot: it proves the release template (manifest +
> `dist/` build + changesets + `release.yml` provenance publish) that every
> Wave 0–3 leaf reuses. M0 exit is met once `cas` is published from
> `bounded-systems/cas` and `ai-home` consumes it as a published version (the
> consume-back flip is the gated follow-up).

Status values: `not-started` → `in-progress` → `extracted`
(plus `M0 pilot` for the leaf that proves the pipeline).

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
