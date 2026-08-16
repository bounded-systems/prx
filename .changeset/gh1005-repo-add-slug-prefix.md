---
"@bounded-systems/prx": patch
---

Fix `prx repo add <external-url>` failing on its last step (GH-1005). The bare
clone, mainx worktree and registry write all succeeded, then `addLocalRepo`
shelled out to `bd config get database.workspace_prefix` and treated any failure
as fatal — leaving a registered-but-unfinished repo. GH-1012 removed the bd/beads
write plane, so that probe fails on every repo without a pre-existing `.beads/`,
and on every repo at all once `bd` is off the operator's PATH.

The probe is now best-effort with a slug derivation behind it — the same ladder
`prx repo backfill` already used for stale entries, so the two verbs agree on how
a prefix is derived. That also yields the slug-shaped prefix (`icfp2026`) instead
of the worktree-dir-shaped one (`mainx`) an operator got by reaching for `bd init`
directly. `RepoAddResult` gains `bdWorkspacePrefixSource`
(`override` | `bd-config` | `slug-derived`), which `formatRepoAdd` now prints
alongside the prefix. A slug that projects to nothing `WORKSPACE_PREFIX_PATTERN`
accepts is the one remaining hard failure (`bd_workspace_prefix_underivable`) —
unlike the probe it replaces, it names a fix the operator can carry out.

`prx repo bootstrap` no longer dead-ends. It can only refuse (GH-1012 left it a
stub), but its inventory/locate/worktree/prefix gates ran first, so an
externally-added repo hit `no-inventory` and was told to run `prx repo list` —
which neither creates a per-worktree inventory for an external repo nor changes
the outcome if it did. The `beads-removed` refusal is hoisted ahead of the gates
so every caller gets the one true reason, and points at `prx repo add`.
