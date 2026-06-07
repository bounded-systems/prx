# @bounded-systems/prx

## 0.7.0

### Minor Changes

- 6bb29a9: Add `prx observe <unit>` — a read-only reader over the audit NDJSON that surfaces a work unit's pilot telemetry timeline (leg heartbeats + seam start/done events). The operator-facing surface for the pilot's `TELEMETRY_*` stream; complements `tail`/`jq` and `PRX_AUDIT_STDOUT=1`. Supports `--limit N` for the most recent events.

### Patch Changes

- 22c949b: Add `prx beads provision --origin <owner/repo> [--cwd <path>]` — the host twin of `prx lima provision-beads`. It dolt-clones the canonical beads into the well-known `~/.local/state/prx/beads` (writing the server-mode `metadata.json` bd needs), so the local daemon serves one healthy beads from every worktree. With this provisioned, `resolveLocalBeadsCwd` auto-selects it and `prx beads ready|list|show` returns real data from any shell — no per-worktree `bd` and no `--vm`.
- 13530a9: `prx beads ready|list|show` is now the reachable beads surface from **any shell**: with no `--vm` it routes through the local daemon via `withBeadsClient` (auto-started), instead of requiring `--vm`/`PRX_BEADS_VM`. `--vm <name>` still targets an in-VM daemon explicitly. This gives interactive agents and humans a working beads path even where raw `bd` is unreachable in a worktree (`issue_prefix config is missing`). The `/prx` orchestrator command now points at `prx beads show` for this reason.
- d93f98f: Adds the local CI provenance projection (GH-352): a `ci` field on `DomainStateV1` (verdict + freshness), the `resolveCiProvenanceState` reader (merge-guard verdict for HEAD plus an `isStale` freshness check — does the recorded green still cover the current tree?), and a uniform `isStale` check in the merge-guard (`projectProvenanceAxis`) so a verified-but-stale derivation fails closed. `buildDomainState`/`prx snapshot` stay synchronous and ledger-free; the `ci` field defaults there pending an async-snapshot follow-up.
- d93f98f: `prx ci` accepts a `PRX_CI_LEDGER` override for the signing ledger, so it can sign in a bare CI checkout (where the workspace-resolved canonical ledger doesn't exist). `.github/workflows/ci.yml` uses it to sign each phase (gated on a `PRX_PROVENANCE_KEY` secret) and uploads the ledger as the chain's async mirror — so remote greens join the same signed chain as local ones. Fully no-op without the secret. (GH-352)
- cfc778f: The local beadsd auto-start now serves a **canonical** beads clone decoupled from the current worktree (GH-296), so `prx beads` returns the same healthy beads from any shell instead of whichever clone's (possibly broken) `.beads` is underfoot. `resolveLocalBeadsCwd` resolves it: `PRX_BEADS_CWD` (explicit override) → the well-known `~/.local/state/prx/beads` clone when present → `findRepoRoot()` (back-compat fallback).

## 0.6.0

### Minor Changes

- 3951ba9: Anchor pilot telemetry into the signed `prx.pilot/v1` summary as an `observed: { digest, count }` field — a hash chain over all seam + leg-heartbeat observations, committed to by the pilot's existing signature. Tamper-evident with zero extra signatures, and never a gate (health stays off the authority chain). Slice 4 of the local-CI-in-the-pipeline work.
- 8eb3397: Add `prx observe <unit>` — a read-only reader over the audit NDJSON that surfaces a work unit's pilot telemetry timeline (leg heartbeats + seam start/done events). The operator-facing surface for the pilot's `TELEMETRY_*` stream; complements `tail`/`jq` and `PRX_AUDIT_STDOUT=1`. Supports `--limit N` for the most recent events.

### Patch Changes

- c0cc075: `prx ci` now records a signed `ci/phase/v1` derivation for each phase that _passed_ even on a partial (failed) run — not only on a fully green run — so a failure still leaves verified, content-addressed evidence for the phases before it (absence of a phase's derivation ≡ that phase not verified). (GH-352)
- 5f21402: `prx ci` accepts a `PRX_CI_LEDGER` override for the signing ledger, so it can sign in a bare CI checkout (where the workspace-resolved canonical ledger doesn't exist). `.github/workflows/ci.yml` uses it to sign each phase (gated on a `PRX_PROVENANCE_KEY` secret) and uploads the ledger as the chain's async mirror — so remote greens join the same signed chain as local ones. Fully no-op without the secret. (GH-352)
- 2cd110c: `prx plan view` and `prx intake view` now read beads through the beadsd daemon (the "one true source", GH-296) via a **targeted** `show <id>` rather than loading the whole set and filtering in JS — a single-id view asks the daemon for that one record, which is both cheaper and keeps provenance to `(query → result)` instead of the entire DB.

  Also fixes a correctness bug in the daemon readers: the daemon returns raw `bd --json` (snake_case `external_ref`, `issue_type`, …), which was being cast straight to `BeadsRecord`. The snake→camel parse (`parseBeadsRecord` / `parseBeadsRecords`, extracted from `loadAllBeads`) is now applied host-side, so `externalRef` / `externalRefs` / `externalIssueNumber` are populated correctly.

- 1487a2b: Emit the pilot and fleet machines' own state transitions to the audit sink
  (`machine:"pilot"` / `machine:"fleet"`), via `makeAuditInspector`. The monitor
  already greps `machine:pilot`, so pilot retreats/loops are now observable —
  the unblocker for diagnosing the implement/test loop (GH-360).
- 2b2a7c6: `prx plan view` now reads beads through the beadsd daemon (the "one true source", GH-296 wave 1) instead of shelling out to a local `bd list --all`. The bd-record arm fails fast if beadsd is unreachable. Also fixes a latent TDZ in the `resolver ↔ intake-id` import cycle by making the `IntakeViewError` alias a live re-export.
- 3951ba9: Fix: `TELEMETRY_SEAM_OBSERVED` was emitted by the pilot's deterministic seams but never registered in `eventOwnerMap`, so `recordEvent` threw `unknown catalog event` and the best-effort sink wrapper silently swallowed it — seam telemetry never reached the audit log. Register it (owner `telemetry`) so the seam stream (intake/checks/ci/merge start/done) lands in the tailable audit NDJSON alongside the leg heartbeat, making a pilot run observable to operators.

## 0.5.0

### Minor Changes

- f0f6f1b: Anchor pilot telemetry into the signed `prx.pilot/v1` summary as an `observed: { digest, count }` field — a hash chain over all seam + leg-heartbeat observations, committed to by the pilot's existing signature. Tamper-evident with zero extra signatures, and never a gate (health stays off the authority chain). Slice 4 of the local-CI-in-the-pipeline work.

## 0.4.0

### Minor Changes

- cf7bc8e: beadsd — beads as a capability-isolated daemon (GH-228/GH-296)

  Run beads behind a daemon so the host (human + agents) queries one source instead
  of N drifting per-worktree dolt clones:

  - `prx lima up|down|daemons|status` — manage in-VM daemons (keeper + beads) over a
    daemon registry; `prx lima provision-beads <vm> --origin <owner/repo>` installs
    bd+dolt and clones the canonical beads into a Lima VM.
  - `prx beads serve` (in-VM read+write daemon: ready/list/show/create/update/close,
    single-writer under the bd policy gate) and `prx beads ready|list|show --vm`
    (host read-door over the Lima-SSH channel).
  - `prx beads doctor [--fix]` — diagnose / re-bootstrap an unhealthy beads clone.
  - Config-driven dolt-database namespace resolver (reverse-DNS is now a swappable
    policy, decoupled from the SQL-safety guard).

  Validated end-to-end against a real Lima VM (local + VM e2e tests).

## 0.3.2

### Patch Changes

- 84b4579: `plugin emit`: route the capability `PreToolUse` hook through a bundled resolver
  script (`bin/prx-policy-guard.sh`) instead of a bare `prx hook policy-guard`.

  The bare command is PATH-dependent: when Claude Code is launched from a GUI /
  Spotlight / launchd context (not a shell), the hook subprocess can inherit a
  minimal PATH without `~/.local/bin`, so `prx` resolves to "command not found"
  and the policy guard silently stops enforcing. The resolver finds `prx` by PATH
  first, then common install locations (`$XDG_BIN_HOME`/`~/.local/bin`, homebrew,
  `/usr/local/bin`, the nix system profile), mirroring the monitor's existing
  `${CLAUDE_PLUGIN_ROOT}` script pattern. Surfaced by dogfooding the emitted
  plugin against the v0.3.1 binary.

## 0.3.1

### Patch Changes

- Re-cut the v0.3.x binary release as **0.3.1**. The first v0.3.0 binary release
  shipped broken — only `prx-x86_64-linux` attached, because the release-binary
  matrix published the GitHub Release in parallel and the second job hit the
  immutable-release lock. The pipeline is fixed (build → artifacts → single
  draft-then-publish release job, #209), but immutable releases permanently
  reserve the `v0.3.0` tag name, so the corrected release ships as 0.3.1. No
  source changes from 0.3.0 — same binary, working release pipeline.

## 0.3.0

### Minor Changes

- 0a8a8bc: **Experimental: pilot/fleet pipeline orchestrator + spec-driven CLI surface.** A
  preview subsystem (tested; not yet wired as `prx` commands — the real run is
  behind `PRX_PILOT_REAL` and gated on the dolt actor). Ships as a tested
  subsystem behind the existing surfaces.

  - **feat(orchestrator):** `pilot` (Layer 1) drives one work unit — each role leg
    invokes a headless Claude subagent (no tmux, "claude over ssh") and signs an
    in-toto step link. The tail `awaiting_ci → ready_to_merge → sealing → merged`
    makes "CI is a HARD BLOCK" _structural_ — the only edge to merge runs through
    a settled-green gate. Termination is proven via a well-founded measure
    `[retreatBudget, distanceToMerged] ∈ ℕ²`. `fleet` (Layer 2) supervises many
    pilots, WIP-bounded, projecting a live board (the agents view) + a signed
    batch attestation.
  - **feat(provenance):** a signed in-toto tree — leg step → pilot summary
    (`prx.pilot/v1`) → fleet batch (`prx.fleet/v1`), real ed25519/DSSE via
    `resolveProvenanceSigner`; verifiable, tamper / wrong-key rejected.
  - **feat(cli-spec):** author a verb once as a Zod `VerbSpec`; project it to CLI
    / MCP / OpenAPI / Anthropic tools / a Claude Code plugin / `prx mcp serve`,
    with a namespaced router and an actor→tool permission projection — the basis
    for collapsing `cli.ts` to a thin router + pretty-printer.
  - **feat(invariant):** no prx agent launches without a signing key
    (`requireSigner`); the CLI is modeled as an actor that inherits identity from
    the controlling tty (`cliActor` → `human` / `noninteractive`,
    `requireCliSigner`).
  - **feat(real):** the `prx pilot` real path (`PRX_PILOT_REAL`) wires legs to
    `openSession` + a headless role agent + the Signer, and the tail to the real
    `prx scout ci` / `prx publisher merge` actors.

  Design: `docs/prx/pipeline-orchestrator.md`, `docs/prx/cli-from-spec.md`.

### Patch Changes

- 4d8d08e: Capability-poor orchestrator, beads-native pipeline, and the compiled-binary audit-DB fix.

  - **fix(audit):** embed `schema.sql` into the `bun --compile` binary — fixes the `ENOENT /$bunfs/root/schema.sql` that broke every audit-DB command (e.g. `prx services status --anthropic`) in the released binary (prx-eky).
  - **feat(submit):** beads-native submit / publish / merge — a beads work unit can travel intake → merged PR (no longer GitHub-issue-only).
  - **feat(agents):** capability-poor orchestrator — actor sub-agents generated from the policy table, a PreToolUse policy hook that denies any command a role doesn't own, orphan-effect provenance verification, and the intake⊗actor salt + ephemeral salted worktrees for per-actor isolation.
  - **feat(commands):** `/prx <unit>` — drive a work unit through the pipeline (plan → implement → submit → merged PR), capability-scoped and delegating to prx's actors.
  - **chore:** automatic GitHub-issue tracking (`intake --to gh` + `Closes #N`/postmerge); value-props + `STATUS.md`; capability ownership/approval `.feature` audit surfaces.

- e6882e0: dolt: add `createDoltDatabase` — an idempotent `CREATE DATABASE` primitive for the shared dolt sql-server (E0 of GH-1685). Probes `SHOW DATABASES` then creates the empty database when absent, reporting `created` / `exists` / `error`; re-validates the canonical reverse-DNS name before any SQL interpolation. Schema seeding (E1, `bd init --database`) and the `prx repo provision` verb (E4) compose it.
- 11d76cf: dolt: canonical `dolt_database` naming standardized on the live reverse-DNS form `io_github_<owner>_<repo>` (D0 of GH-1685). `RepoSlug` now validates that shape (exported as `DOLT_DATABASE_NAME_PATTERN`), and a new `canonicalDoltDatabase()` derives it from a GitHub origin. The legacy `{host}__{owner}__{repo}` form is no longer accepted.
- d6ee05a: deps: migrate to zod 4 (`^4.4.3`). Replaces the Zod-3-only `zod-to-json-schema` with Zod 4's built-in `z.toJSONSchema` behind a shared `toJsonSchemaArtifact` helper (preserving the `{ $ref, definitions }` artifact wrapper), switches `z.record(value)` call sites to the Zod-4 `z.record(key, value)` arity, uses `z.partialRecord` for enum-keyed counters, and updates config-drift issue introspection to Zod 4's `invalid_value`/`values` issue shape. Committed JSON-schema artifacts were regenerated (Zod 4 emits nullable unions as `anyOf` and bounds integers at `MAX_SAFE_INTEGER`); the contract artifacts also pick up roles that had drifted from source. prx-mt9.
