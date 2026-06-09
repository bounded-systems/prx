# @bounded-systems/prx

## 0.10.0

### Minor Changes

- 00ba898: feat(fetch): `prx fetch slack` drains the history cursor so one run gets the whole channel (prx-13x)

  The pure core now pages `conversations.history` from the watermark to the end
  of the delta (cursor pagination) instead of reading a single page, so
  `prx fetch slack <channel>` fetches **all** messages newer than the watermark
  in one run — no gap when a channel has more than `--limit` new messages. The
  read adapter surfaces the provider's `next_cursor`; the core loops until the
  cursor drains, a `--max-pages N` bound is hit, or the cursor stops advancing
  (defensive against a stuck cursor). Messages are deduped by `ts` across pages;
  the watermark advances once to the global max; the JSON summary reports
  `pages`.

  Defaults to draining the full delta; `--max-pages N` caps the pages per run
  (`--max-pages 1` restores the old single-page behaviour). Rate-limit/budget
  gating remains a follow-on (blocked on slackd, prx-tgy) — Slack has no
  github-budget points bucket.

- 731fd15: feat(fetch): content-scoped digest + SlackMessageContent zod/JSON schema for `prx fetch slack` (prx-psj)

  `prx fetch slack` now content-addresses each message by a **content projection**
  instead of the whole message: `sha256(canonical({channel, content}))` where
  `content` = identity (`ts`, `user`, `type`/`subtype`) + content (`text`,
  `blocks`, `files`, `attachments`). Volatile metadata — reactions,
  `reply_count`/`latest_reply`/`reply_users*`, `subscribed`, `is_locked`,
  `last_read`, `client_msg_id`, `team`, the `edited` wrapper — is dropped, so
  reaction/reply churn **dedups to nothing** and only a real content edit busts a
  message's digest. `ts` stays in the projection as identity (so identical text
  like "lgtm" doesn't collide into one blob).

  Adds `fetch/slack-content.ts`: the `SlackMessageContent` **zod** schema (source
  of truth), `projectSlackContent()`, and `slackMessageContentJsonSchema` (derived
  via `z.toJSONSchema`) — the typed contract a read-back/query surface can emit
  against.

  Migration: digests change shape, so the first fetch after this re-stores each
  message once under its content digest (pre-1.0, channels are small — negligible).
  Parent epic: prx-zes.

### Patch Changes

- 972325b: fix(beadsd): resolve the runtime repo root from cwd, not the binary dir (prx-ag7)

  beadsd's `client-factory` used `findRepoRoot()` — the build-time `.git`-marker
  walk whose default start is `import.meta.dir` — as its _runtime_ fallback. In a
  `bun --compile` binary (e.g. prx inside claude-box) that's `/$bunfs/root`, so
  repo-scoped verbs crashed with `findRepoRoot: no .git ancestor of /$bunfs/root`.
  Use `getRepoRoot()` (the `git rev-parse --show-toplevel` cwd resolver) for the
  runtime path; `findRepoRoot` stays for build/codegen.

- 91d21f8: feat(workspace): emit signed worktree-add/v1 in production (prx-hc5 slice 2 / prx-3qc)

  Wires keeper's `attestWorktreeAdd` (slice 1) into the live `claude --worktree`
  path. After a real materialization, the create hook emits a signed
  `worktree-add/v1` for the new worktree — opt-in + fail-safe, mirroring keeper
  push:

  - `resolveProvenanceSigner()` (the `PRX_PROVENANCE_KEY` env seam) → no key ⇒ no
    emission;
  - `resolveCanonicalChainLedger(targetPath)` → the per-workspace anchored-chain
    ledger (I-WS5: never under the mainx replica) ⇒ no ledger, no emission;
  - base commit (`origin/main`, what the branch was cut from) recorded as a
    material when resolvable;
  - only on a real placement (`status: "created"`, not the idempotent `exists`);
  - best-effort — a signing/ledger failure never aborts worktree creation.

  Injectable (`WorktreeHookCliDeps.emitProvenance`) for tests. Completes
  `docs/prx/worktree-provenance.md`'s slice 2.

## 0.9.0

### Minor Changes

- 14d2832: feat(fetch): `prx fetch slack <channel>` — sync a channel's reads to CAS with a per-channel watermark (prx-agd)

  Wraps the pure freshness/CAS core (`runFetchSlack`) with its three production
  seams: the gated `scout slack` read surface (now accepting `oldest`/`latest`),
  the on-disk plan-store CAS on a new `slack` domain (deduping each
  `conversations.history` message by content digest), and a per-channel
  `bd config` watermark (`prx.fetch.slack.<channel>.watermark`) advanced to
  `max(ts)` after each successful fetch. Idempotent end-to-end.

  Scope (v0): one read per run. Multi-page pagination (the `cursor` carry) and
  rate-limit/budget gating are deliberate follow-ons — Slack has no
  github-budget points bucket, so meaningful gating belongs with slackd
  (prx-tgy). Parent epic: prx-zes.

### Patch Changes

- 10136a1: feat(keeper): signed `worktree-add/v1` provenance for worktree materialization (prx-hc5)

  Worktree materialization (`claude --worktree` → keeper's `git worktree add`) was
  the one keeper git-write with no signed record. Keeper can now attest it, like
  `push/v1`:

  - `WORKTREE_ADD_BUILD_TYPE` (`https://prx.dev/git/worktree-add/v1`).
  - `attestWorktreeAdd(attest, {branch, targetPath, baseCommit?})` — emits a signed
    SLSA derivation whose **subject is the new worktree's branch tip** (declared,
    resolved via `HEAD` in the target worktree — `git worktree add` doesn't move the
    cwd's HEAD, so the self-describing `attestingGit` strategy doesn't apply), with
    the base commit as a material. Opt-in (only with a signer+ledger) and fail-safe
    (missing/malformed HEAD → no link), mirroring `runKeeperPush`.

  `runKeeperEnsureWorktree` stays synchronous; the attestation is a separate
  composable async step so `reserve`/`materialize`/the hook adapter don't inherit
  an async cascade.

  This replaces the rejected "route resolution reads through scout" framing
  (scout is for file-content reads, not git-state/infra reads — audited in the
  ADR). Production wiring (threading keeper's signer+ledger from the hook) is the
  deferred second slice. See `docs/prx/worktree-provenance.md`.

- 289550c: feat(workspace): `--repo <dir|slug>` makes `claude --worktree` dir-agnostic (prx-hot)

  The worktree hooks should resolve the repo explicitly rather than depend on
  whatever cwd Claude runs them from. `prx workspace worktree-create|worktree-remove`
  now accept `--repo <value>`:

  - an existing **directory** → used as the resolution anchor;
  - otherwise a **repo-registry slug** → resolved to its `mainWorktree ?? commonDir`
    via the same `loadRepoInventoryConfig → loadRepoInventoryIndex → findRepoBySlug`
    path `prx plan session --repo <slug>` uses.

  `prx workspace worktree-hooks [--repo <value>]` bakes `--repo <value>` (shell-quoted)
  into the registered `settings.local.json` hook command, so the hook runs from any
  cwd. Omitted → plain commands (resolution falls back to the invocation cwd + the
  prx-ph7 bare-repo fallback). Verified end-to-end from `/tmp` with both a bare-repo
  dir and the `prx` slug.

- fe6d721: fix(workspace): resolve the repo from a bare repo so `claude --worktree` works (prx-ph7)

  `claude --worktree <name>` failed with `workspace.reserve: cwd is not a
recognized GitHub repo`. Claude Code runs `WorktreeCreate`/`WorktreeRemove`
  hooks from the **bare repo** (the git common dir), which has no working tree, so
  `resolveRepoToplevel` (`git rev-parse --show-toplevel`) returned null and both
  `reserve` and `materialize` failed closed.

  prx now resolves the layout itself instead of depending on being launched inside
  a worktree: when `--show-toplevel` fails, `resolveRepoToplevel` falls back to the
  first non-bare worktree from `git worktree list --porcelain` (origin + the
  worktree list both resolve fine from a bare repo). keeper's `git worktree add`
  already worked from the bare repo — this just feeds reserve/materialize a real
  worktree path to compute the sibling placement against. Extracted
  `firstNonBareWorktree` as a pure, unit-tested parser.

  Fixes the live `claude --worktree` smoke-test failure from the prx-6jb/prx-5q3
  rollout.

## 0.8.3

### Patch Changes

- f90dbdc: feat(adapters): route the gh mirror write-back through the daemon (GH-296)

  `GhDomainAdapter.push()`'s unlinked-create path wrote the new issue URL back to
  bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
  That write-back now goes through `updateBeadViaDaemon` (the single writer), using
  the `update --external-ref` field added to the daemon contract. `push()` is async,
  so it awaits the helper directly; the writer is injectable (`deps.updateBead`) for
  tests and defaults to the daemon helper in production. The cache `invalidate()` on
  success is unchanged. Another bulk write reconciler off host bd, toward prx-82b.

- 6ba5079: feat(tools): route the bd close primitive through the daemon (GH-296)

  `execBdIssueClose` — the single `bd close` wrapper behind `submit postmerge`, the
  gh adapter's `bulkClose`, and `intake merge`'s dup close — spawned host `bd close
<id>` against the per-clone `.beads`. It now spawns `prx beads close <id>
[--reason]`, which the daemon maps to `bd update --status closed --notes`. One
  spawn-target change migrates all three callers' close path off host bd at once.
  Toward removing host bd (prx-82b).

- 3f51a14: feat(triage): route close-stale's WRITE through the daemon (GH-296)

  `triage close-stale` closed stale beads with host `bd update -s closed --notes …`
  against the per-clone `.beads`. Its write now runs `prx beads close <id> --reason …`
  through the daemon (the trusted single writer; maps daemon-side to
  `bd update --status closed --notes`). A sync subprocess keeps `runTriageCloseStale`
  synchronous (no async ripple to its 14 call sites / the CLI), matching the prx-fda
  read pattern; the runner is injectable for tests. Another bulk write reconciler
  off host bd, toward prx-82b.

- 207cd7f: ci(coverage): add an 85% line-coverage gate + cover the last sub-80% files

  `coverage-summary.ts` gains a `--min <pct>` flag that exits non-zero when parsed
  line coverage is below the threshold; the coverage workflow now runs it with
  `--min 85`, so the `coverage` job fails below the 85% floor (the project sits at
  ~87%). Also raises the remaining sub-80% files: `beads/workspace_mode` 77→96%
  (probeSharedServerHasIssues + readBeadsMetadata arms), `tools/agent_doctor`
  76→83% (classifyError categories + truncate), and `beads/migrate` 79→82%
  (the non-embedded refusal modes).

- 7e490e1: test(prx): make pr-state/status-report testable + cover it → 100%

  `refreshTaskSignals` read the worktree branch + live PR signals through direct
  git/gh imports, so its signal-reconciliation logic was untestable (the file sat
  at ~19%). Add a `StatusSignalsDeps` seam (loadReviewConfig / currentBranchName /
  fetchPrSignalInfo, defaulting to the real impls), threaded through `renderStatus`,
  so every reconciliation branch is drivable against an on-disk task-contract
  fixture with no git branch or GitHub round-trip. 19% → 100%.

- f93d4ec: feat(beadsd): add a `dep` write kind to the daemon (GH-296)

  The daemon write contract gains a structured `dep` kind —
  `bd dep add --type <t> <from> <to>` / `bd dep remove <from> <to>` — threaded
  through the wire contract, the daemon dispatch (with a special-case: `bd dep` is
  not a `--json` surface, so a zero exit replies ok/null), a `depViaDaemon` helper,
  and a `prx beads dep add|remove` CLI. This is the last missing daemon write
  capability; it unblocks the dependency-edge reconcilers still on host bd
  (promote-children parent-child wiring, dedupe edge rewire) — toward prx-82b.

- af67dca: feat(beadsd): extend the daemon `update` write with `--external-ref` / `--notes` (GH-296)

  The daemon write contract's `update` kind gained `externalRef` and `notes`
  (both valid `bd update` flags) — threaded through the wire contract, the daemon's
  `bd` dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update` CLI
  (which also now exposes the already-contracted `--type`). This is the Group-B
  infra that unblocks the remaining bulk write reconcilers still on host bd: the
  adapter mirror write-back and `prx beads publish` (`--external-ref`), and
  intake-comment (`--notes`). No behavior change to existing callers — purely
  additive optional fields. A step toward removing host bd (prx-82b).

- 4718b8c: feat(doctor): route dedupe-bd's edge + close WRITES through the daemon (GH-296)

  `prx doctor dedupe-bd`'s apply phase rewrote dependency edges and closed
  duplicates with host `bd dep remove`/`bd dep add`/`bd update -s closed` against
  the per-clone `.beads`. All three now run through the daemon — `prx beads dep
remove|add` (the `dep` kind from #537) and `prx beads update <id> --status closed
--notes` (the close). The close argv switched `-s` → `--status` so it passes to
  the typed CLI. A sync runner keeps `runDedupeBd` synchronous; injectable for
  tests. Toward removing host bd (prx-82b).

- 5a6a586: feat(delegate): route `delegate assign`'s WRITE through the daemon (GH-296)

  `prx delegate assign` wrote the owner with host `bd assign <id> <name>` against
  the per-clone `.beads`. The write now runs `prx beads update <id> --assignee
<name>` through the daemon (single writer; `bd assign` is shorthand for
  `bd update --assignee`, empty string clears). A sync subprocess keeps
  `runDelegateAssign` synchronous; the runner is injectable for tests. The
  eligibility read (`runBdShow`) is a separate no-cache path for a later pass.
  Toward removing host bd (prx-82b).

- 6887963: feat(triage): route drift-fix WRITES through the daemon (GH-296 prx-ebo)

  `triage drift-fix`'s apply phase mutated beads with host `bd update`/`bd reopen`
  against the per-clone `.beads` — the broken store GH-296 is retiring. Its two
  write seams now go through the daemon (the trusted single writer):

  - type/priority fix → `updateBeadViaDaemon(id, { issueType, priority })`
  - status fix → `reopenBeadViaDaemon(id)`

  Both default to the beadsd helpers and are injectable (`deps.updateBead` /
  `deps.reopenBead`) for tests. The helpers throw on a non-ok daemon verdict
  (vs `execBd`'s exit code), so a failed write records `exitCode: 1` + the daemon's
  message in the audit row (partial-write accounting unchanged). The aggregate read
  already routes through the daemon via the BeadsCache loader (prx-fda).

  A step toward removing host bd (prx-82b): the remaining bulk write reconcilers
  (promote, intake-mirror/merge/comment, close-stale, dedupe deps, adapters
  write-back) are the next sites.

- 374beb1: feat(beads): route the aggregate bead read through the daemon by default (GH-296)

  The per-invocation `BeadsCache` — threaded by runCli into every read verb (sync,
  intake, triage, scout, adapters) — now reads through the daemon (the GH-296 one
  true source) instead of spawning host `bd list` against the broken per-clone
  `.beads`. This flips the production aggregate-read path off host bd in a single
  move (prx-fda).

  - New `triage/beads-daemon-loader.ts` `loadAllBeadsViaCli`: a SYNC
    `prx beads list --all --limit 0` spawn (same daemon query as
    `loadAllBeadsViaDaemon`: `{kind:"list", all:true, limit:0}`), parsed with the
    existing `parseBeadsRecords`. Sync on purpose — `loadAllBeads`/`BeadsCache.load`
    are called deep inside sync verb code, so a subprocess avoids an async ripple
    across ~24 call sites. Recursion-safe (`prx beads list` reads via the socket
    door, not this cache). Fail-loud on an unreachable daemon — never silently
    reports zero beads. Honors a `prxBinary` override for non-PATH invocation.
  - `createBeadsCache` defaults to this daemon loader; an injected `loadAllBeads`
    (tests, or an explicit local-bd loader) still wins and receives `exec`.

  A step toward removing host bd (prx-82b): the bulk WRITE reconcilers and any
  no-cache `?? defaultLoadAllBeads` fallbacks remain on bd and are the next steps.

- 4398eab: feat(fetch): route the GH→bd sync writer's update through the daemon (GH-296)

  The fetch writer mirrored GH issue state into bd with host `bd update <id>
--external-ref … --status … --title …` against the per-clone `.beads`. It now
  runs `prx beads update …` through the daemon. This also extends the daemon `update`
  write contract with `--title` and `--description` (threaded through contract,
  daemon dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update`
  CLI) — the last update fields the bulk reconcilers needed. A sync runner keeps
  `writePage` synchronous; injectable for tests. Toward removing host bd (prx-82b).

- 1357b7d: feat: add @bounded-systems/host capability; route all prx/src node:os ambient reads through it

  `os.homedir()` / `os.tmpdir()` / `os.hostname()` are ambient host authority that
  was being read raw from `node:os` across ~20 prx/src files — a hidden dependency
  that escaped import analysis and (because `os.homedir()` ignores `$HOME` on
  macOS) could not be redirected in tests.

  New `@bounded-systems/host` package is the one sanctioned reader of that state,
  mirroring `@bounded-systems/env` for `process.env`:

  - `homeDir()` honors an explicit `$HOME` override (via @bounded-systems/env)
    before falling back to `os.homedir()`, so tests/sandboxes can redirect it;
  - `tmpDir()` / `hostName()` wrap `os.tmpdir()` / `os.hostname()`.

  Every `prx/src` caller now imports from `@bounded-systems/host`, and the
  ambient-authority guard gains a rule forbidding raw `node:os` in `prx/src`
  (a hard guarantee, mirroring the existing `process.env` ban).

- e9add44: feat(intake): route intake-comment's bd note WRITE through the daemon (GH-296)

  `prx intake comment` on a bd-shaped id appended its note with host `bd update <id>
--notes …` against the per-clone `.beads`. It now runs `prx beads update <id>
--notes …` through the daemon (using the `update --notes` field added in #528). A
  sync subprocess keeps `runIntakeComment` synchronous; runner injectable for tests.
  Toward removing host bd (prx-82b).

- 23c9cf9: feat(intake): route `prx intake`'s bd create through the daemon (GH-296)

  `prx intake` created its bd record with host `bd create --silent --type … --title
…` against the per-clone `.beads`. It now runs `prx beads create --type … --title
… [--description]` through the daemon and parses the created id from the JSON echo
  (no `--silent`). The `--to gh` publish leg is threaded the same sync runner so its
  write-back also routes through the daemon. Toward removing host bd (prx-82b).

- 23fb674: feat(intake): route intake-merge's pointer-note WRITE through the daemon (GH-296)

  `prx intake merge`'s bd↔bd arm appended the merge pointer note with host `bd
update <id> --notes …` against the per-clone `.beads`. It now runs `prx beads
update <id> --notes …` through the daemon. A sync runner keeps `runIntakeMerge`
  synchronous; injectable for tests. The dup close still flows through
  `execBdIssueClose` (migrated separately at the close primitive). Toward removing
  host bd (prx-82b).

- 5181fb9: feat(intake): route intake-mirror's bd create through the daemon (GH-296)

  `prx intake mirror` created the bd record for a GH issue with host `bd create
--silent --external-ref … --title …` against the per-clone `.beads`. It now runs
  `prx beads create --type task --external-ref … --title …` through the daemon and
  parses the created record's id from the JSON echo (no `--silent` id-line needed).
  Also exposes `--external-ref` / `--silent` on the `prx beads create` CLI (the
  contract already carried them). A sync runner keeps `runIntakeMirror`
  synchronous; injectable for tests. Toward removing host bd (prx-82b).

- 106f3f1: feat(adapters): route the notion adapter's writes through the daemon (GH-296)

  `NotionDomainAdapter` wrote bd with host `bd update <id> --metadata
external_refs.notion=<pageId>` (the mirror write-back) and `bd update <id>
--status closed` (bulkClose) against the per-clone `.beads`. Both now run
  `prx beads update …` through the daemon. This also adds `--metadata` to the daemon
  `update` write contract (threaded through contract, dispatch, the
  `updateBeadViaDaemon` helper, and the `prx beads update` CLI). A sync runner
  replaces the `bdExec` getter; injectable for tests. This was the last bd WRITE
  reconciler on host bd — toward removing host bd (prx-82b).

- 91cd966: ci(coverage): add a per-file coverage ratchet (every src/ file ≥ 80%) alongside the global 85% gate

  `coverage-summary.ts` gains `--per-file-min <pct>`: every product source file
  (`packages/**/src/**`, tests excluded) must clear the floor unless it is in
  `PER_FILE_BASELINE`. The baseline only SHRINKS — a baselined file that climbs
  to/above the floor (or is deleted) goes "stale" and fails the gate, so fixing a
  file forces dropping its baseline entry. The coverage workflow runs the gates at
  `--min 85 --per-file-min 80`; the seven currently-exempt files (deprecated tui,
  the in-decomposition cli.ts/cli-spawn, the triage haiku files pending #502, and
  session/open) are baselined with reasons.

- c89a5f2: feat(triage): route promote-children's dep-edge WRITE through the daemon (GH-296)

  `triage promote-children` wired parent-child / blocks edges with host `bd dep add
--type <t> <from> <to>` against the per-clone `.beads`. It now runs `prx beads dep
add …` through the daemon (the `dep` write kind added in #537). A sync subprocess
  keeps `runTriagePromoteChildren` synchronous; runner injectable for tests. Toward
  removing host bd (prx-82b).

- bc16fa4: feat(triage): route `triage promote`'s bd create through the daemon (GH-296)

  `prx triage promote` created bd records for GH issues with host `bd create
--silent --external-ref … --type … -p … --title …` against the per-clone
  `.beads`. It now runs `prx beads create --external-ref … --type … --priority …
--title …` through the daemon and parses the created id from the JSON echo (no
  `--silent`; `-p` → `--priority`). The GH pointer-comment leg stays on gh. A sync
  runner keeps `runTriagePromote` synchronous; injectable for tests. Toward
  removing host bd (prx-82b).

- 09f5ee8: feat(workspace): prx registers its own `claude --worktree` hooks in settings.local.json (prx-5q3)

  Follow-up to prx-6jb (the `prx workspace worktree-create|worktree-remove` verbs):
  prx now owns the _registration_ too, with no ai-home / `home-manager switch`
  dependency. Hooks are written to `.claude/settings.local.json` — the per-user
  surface prx already manages and the per-worktree stamper never clobbers — not
  project `.claude/settings.json`, which stays permissions-only by design.

  - `ensureClaudeWorktreeHooks(cwd)` (machine/claude_local_settings.ts): idempotent
    merge of the `WorktreeCreate`/`WorktreeRemove` hook block (pointing at the prx
    verbs) into `settings.local.json`; preserves other hooks/permissions; refuses
    to stomp malformed JSON.
  - `prx workspace worktree-hooks`: register the hooks in the current worktree —
    the one-shot for a root/existing worktree the workspace actor won't touch
    (`mainx` is I-WS5 guarded).
  - Self-propagation: `prx workspace worktree-create` now arms the newly
    materialized worktree's `settings.local.json` (best-effort — never aborts
    creation), so a `claude --worktree` launched from inside it also routes
    through prx.

  Activation still requires a release that ships the verbs (the installed prx is a
  release binary). Replaces the ai-home-registration framing of prx-5q3.

- 22b106e: feat(workspace): prx owns the `claude --worktree` lifecycle via WorktreeCreate/WorktreeRemove hooks (prx-6jb)

  `claude --worktree` errors in the bare-repo + external-worktree layout ("not in
  a git repository and no WorktreeCreate hooks are configured"). prx now satisfies
  Claude Code's documented hook contract through its own verbs:

  - `prx workspace worktree-create` — reads the `{ name }` envelope from stdin,
    reserves + materializes a worktree (keeper does the `git worktree add`), and
    echoes the absolute path (Claude reads it as the session cwd; a non-zero exit
    aborts creation).
  - `prx workspace worktree-remove` — reads the `{ worktree_path }` envelope,
    removes the git worktree (keeper) and marks the lifecycle ledger torn_down
    (workspace actor).

  Keeper gains `runKeeperRemoveWorktree`, the symmetric counterpart of
  `runKeeperEnsureWorktree`, so keeper is the sole owner of both `git worktree add`
  and `git worktree remove`/prune; the workspace actor owns only the ledger. The
  adapter (`runWorktreeHookCli`) wires Claude's envelope to that split over the
  existing `worktree-hook.ts` boundary. Hook registration (a thin pointer to these
  verbs) and the wt/wtctl retirement follow separately (prx-arl).

- 07e4320: feat(beads): route `prx beads publish`'s external-ref write-back through the daemon (GH-296)

  `publish`'s link/adopt and create-then-link paths wrote the GH issue URL back to
  bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
  Both write-backs now run `prx beads update <id> --external-ref <url>` through the
  daemon (single writer), using the `update --external-ref` field added in #528. A
  sync runner is threaded through `publishOne`/`publishOneInner`/`linkExistingResult`
  (injectable for tests); the dedup read stays on the existing loader. Toward
  removing host bd (prx-82b).

- 024118d: feat(sync): pull-leg conditional-read core — ETag parser + per-issue ETag store (GH-296)

  The reconcile pull leg (GH→bd) re-reads every pinned GitHub issue every tick and
  is not `--limit`-gated — the sync API hog. This lands the pure, isolated core for
  GitHub conditional requests, ahead of wiring it into the adapter:

  - `sync/conditional-read.ts` — `parseConditionalRead` classifies a `gh api … -i`
    result as not-modified / modified / error. It keys on the HTTP status line, not
    the exit code, because `gh api` exits non-zero on BOTH a `304 Not Modified` and
    a real error (404/410/5xx); a 304 must never be mistaken for a failure, nor a
    failure for "unchanged".
  - `sync/pull-etag-store.ts` — per-(repo,domain) persisted `If-None-Match` cache
    (etag + last derived state) under `~/.local/state/prx/sync/<key>/pull-etags.json`,
    loaded once into memory and flushed in a single write per tick.

  A `304` is free against the GitHub rate limit and GitHub is authoritative on
  changed-vs-unchanged, so reusing cached state on a 304 is provably correct. No
  behavior change yet — nothing calls these until the adapter wiring (prx-lzw step b2).

- e6fca38: feat(sync): wire pull-leg conditional reads into the gh adapter + reconcile (GH-296)

  The reconcile pull leg now does GitHub conditional requests, cutting its per-tick
  rate-limit spend on unchanged issues (prx-lzw lever 1, building on the core in #504):

  - `GhDomainAdapter.pull()` gains an optional `conditionalRead` cache. When wired,
    it issues `gh api repos/{owner}/{repo}/issues/{n} -i -H "If-None-Match: <etag>"`:
    a `304 Not Modified` (free against the rate limit) reuses the cached patch; a
    `2xx` re-parses the fresh REST body and updates the cache; anything else throws.
    The decision is made from the HTTP status line, not the exit code (`gh api`
    exits non-zero on both a 304 and a real error). Absent ⇒ unconditional
    `gh issue view` (unchanged behavior). The REST and `gh issue view` bodies share
    one `parseIssuePatch`.
  - `runBeadsSync` constructs a per-(repo,domain) `createPullEtagStore`, wires it into
    the gh adapter, and flushes it once after the pull leg (one file write per tick).

  A 304 is free and GitHub is authoritative on changed-vs-unchanged, so reusing
  cached state is provably correct (not a client-side heuristic).

- 6435da5: perf(sync): short-circuit the bd→GH push leg when the bead store hasn't moved

  runBeadsSync now reads the dolt clone's `hashof('HEAD')` and compares it against a
  per-(repo,domain) "last successfully pushed HEAD" watermark. When the bead store is
  unchanged since the last fully-successful push, the push leg is skipped entirely —
  no per-bead GitHub mirror writes. The watermark only advances on a clean push
  (no deferrals, no errors), so a partial failure safely retries next tick. `--dry-run`
  never skips. (GH-296 / prx-lzw step a)

- 5b7e625: chore: delete the `@bounded-systems/prx-mux` package (slice 4 of removing tmux entirely). After slices 1–3 removed every tmux caller, the package had no remaining consumers in `packages/prx/src` except a re-export of `CommandRunner`/`defaultRunner` from `@bounded-systems/proc`. Those imports (`gh-pr-fetcher` + example + test) are repointed directly at `@bounded-systems/proc`; the package is removed from the workspace deps + tsconfig paths and deleted along with its tests.
- caf24c4: docs: scrub remaining tmux references after the full tmux removal (slice 5). Updates the agent-session command descriptions (`--interactive for PTY`, no longer "tmux/PTY"), drops the deleted `prx-mux` package from the companion-repos extraction table and the roadmap wave list, refreshes the pipeline-orchestrator "No tmux" note to reflect that tmux is gone entirely (surface, actor, interactive attach, and the `prx-mux` package), and regenerates the derived docs (cli.md, README, jsonld, project.md). Historical design records (the GH-1836 substrate ADR) are left intact.
- ce8b266: refactor: remove the interactive tmux/PTY session path (slice 3 of removing tmux entirely). prx sessions are now headless-only — `prx plan session`, `prx session open`, and `prx implement agent` no longer spawn or attach a durable tmux session; the live session runs directly in the foreground terminal (stdio-inherit) and the implement path runs the headless SDK job in-process. The `prx review` / `prx ultrareview` send-keys verbs (which only existed to inject `/review` into the live tmux pane) and the internal `prx tools mux clear-resurrect` verb are removed, along with the `pr-state/surfaces/tmux.ts` surface reader and the `--interactive`/`--headless` flags on `prx implement agent` (headless is the only mode). The `@bounded-systems/prx-mux` package itself is removed in a later slice.
- de3154f: refactor: remove the tmux parity surface, the tmux/session board actions, and the `prx prune session` command (slice 2 of removing tmux entirely). The board projection no longer reads or stamps a tmux session surface; disposition classifies a unit as complete on the four durable surfaces (worktree + local branch + remote branch + PR) without requiring a tmux session; `worktree-remove` no longer tears down a tmux session; and the `tmux` actor + its reconcile events/facts are dropped from the machine catalog. The interactive `prx review` send-keys path and the `prx-mux` package are removed in later slices. (`prx prune` itself is slated for replacement by `gc`.)
- 5aabf05: feat(delegate): route repair-assignees' assign WRITE through the daemon (GH-296)

  `prx delegate repair-assignees --apply` rewrote bd assignees with host `bd assign
<id> <to>` against the per-clone `.beads`. It now runs `prx beads update <id>
--assignee <to>` through the daemon (`bd assign` == `update --assignee`). A sync
  runner keeps `runRepairAssignees` synchronous; injectable for tests. The matched
  `bd list --assignee` read stays for the reads sweep. Toward removing host bd (prx-82b).

- 77dd2ea: Add the sync API-efficiency design (docs/spikes/prx-ebo): grounds the "sync ate more API requests than necessary" concern — the reconcile's pull leg re-reads every pinned GitHub issue every tick (not --limit-gated) — and sequences the two fixes: pull-leg conditional reads (GitHub ETags / GraphQL batching, the hog) and a push-leg bead-etag short-circuit with retry-safety (the cheap, safe win).
- 0299c53: Add the correctness core of the bd→GH push-leg short-circuit (GH-296, prx-lzw): pure, tested decisions (`shouldSkipPush`, `pushFullySucceeded`, `advanceLastPushedHead`) that let the reconcile skip the push leg — and its GitHub write requests — when the bead store (the daemon's dolt HEAD etag) hasn't moved since the last _successful_ push. Retry-safe: a deferred (`--limit`) or errored push never advances the watermark, so transient failures retry rather than being skipped forever. The `runBeadsSync` wiring (read the etag, persist the watermark) is a thin follow-up over these.
- 23ca06a: refactor(triage): break the triage actors↔machine import cycle; make the per-run actors testable

  `triage/actors.ts` could not be loaded in isolation — `actors → prune-merged →
pr-state/cli → prime → machine → actors` formed an import cycle that threw a TDZ
  on `statusActor` (and dragged the 23k-line CLI in at load time, hanging tests).
  Root cause: `pruneMergedActor`'s delegate reached into `pr-state/cli.ts` for two
  surface-sync/git primitives that never belonged there.

  - Extract `pruneStaleRemoteRefs` + `applyParityChainActions` into a focused leaf
    module `pr-state/parity-chain.ts`; `cli.ts` re-exports them so its existing
    callers (gc drivers, tests) are unaffected, and `prune-merged.ts` imports them
    directly — breaking the cycle and the CLI's load-time pull.
  - Forward an optional, test-only `deps` seam through every real triage actor's
    input to its delegate (mirroring `dep-research/actors`'s `fetcher` seam), so a
    wrapper can be driven hermetically. The machine never supplies it (production
    uses the real deps); behavior is unchanged.

## 0.8.2

### Patch Changes

- 7d44141: `createBeadsCache` is now UoW-coherent and generation-aware (GH-296, prx-ebk): `upsert(record)` patches one record by id (write-through) and `remove(id)` drops one — so a write no longer busts the whole cache. With an optional `generation` source (the daemon's dolt HEAD etag), `load()` re-fetches only when the dataset moved, so a stable HEAD serves cached data. Existing `load()`/`invalidate()` callers are unchanged.
- 33fdb36: beadsd now surfaces a **dataset etag** on every `ok` reply (GH-296, prx-ebk): the served clone's dolt HEAD hash — one cheap content-addressed generation token for the whole bead store. The daemon caches it (read on start + after each reconcile via `prx beads serve`'s `readHead`), so reads don't spawn dolt per request. Unchanged HEAD ⇒ nothing moved, so callers can validate caches and sync can short-circuit (skip redundant GitHub API calls) when the bead DB hasn't advanced. The field is optional; the daemon omits it when no HEAD source is wired.
- 0b70ce5: `prx beads list` now accepts `--all` and `--limit <n>` (GH-296), exposing the aggregate read the wire contract already supported (`list { all, limit }`). `prx beads list --all --limit 0` returns every record across statuses — the shape the bulk readers need. First step of routing the bulk readers through the daemon (epic prx-697 / prx-fda).
- 02e3ae4: beadsd writes are now durable (GH-296, sync-agent epic prx-697): the daemon's periodic refresh upgrades from a pull-only freshness step to a **full dolt reconcile** (commit local writes → pull → push). Daemon writes (create/update/close/reopen, which land in the served clone) are committed and pushed to the canonical remote on the interval, instead of sitting local until the next re-provision. Reuses the `dolt-reconcile` pipeline; quiet and non-throwing — if the push step lacks remote creds it's swallowed, and commit+pull still run (writes stay local, never lost). Leverages dolt's native sync (the data-sync framework) rather than a bespoke pusher.
- c8ec403: Additive testability seams (behavior-preserving): `defaultProbe` and
  `bdDelegatingSpawn` in dolt/start take an injectable spawn (default real), and
  `defaultReadLedger`/`defaultWriteLedger` are now exported, so the bd-backed
  start defaults are unit-testable. Production call sites pass nothing.
- 0c8fec1: Additive testability seams (behavior-preserving): `readSubstrateWatermark` and
  `defaultSubstrateRefresher` in the fetch freshness-gate take an injectable
  reader/fetch (default to the real bd/gh implementations) so their outcomes are
  unit-testable. Production call sites pass nothing.
- a34de92: test(prx): cover the `prx ci` (local-ci) phase internals via a `{ run, capture }` subprocess seam

  `phaseSpec` and `runPhase` now accept an optional `LocalCiRunners` seam
  (defaulting to the real `defaultRunner`/`runCaptured`) and are exported, so the
  spec-building, git-SHA bake, dist-dir prepare, and plain/json phase dispatch are
  testable without spawning the heavy `bun`/`git` tools. Behavior is unchanged for
  existing callers. Coverage 37% → 100%.

- e6f4c58: Add the sync-agent build-vs-adopt decision (docs/spikes/prx-3eu): keep dolt as the data-sync framework (already adopted; the daemon's push durability leverages it), keep the bd↔GitHub reconcile bespoke (it's a cross-system transform, not replica sync), and do not adopt a generic sync/CRDT framework. The sync agent is an orchestrator over dolt + the existing reconciler.

## 0.8.1

### Patch Changes

- 9346a94: Add `prx beads prime` — the daemon-aware session primer (the prx-beads twin of `bd prime`, GH-296). It prints how to reach beads (`prx beads <verb>` through the per-repo daemon, not raw `bd`) plus live ready-work from the daemon. Resilient by design: an unreachable daemon still prints the guidance and exits 0, so it's safe as a SessionStart hook. This is the in-repo enabler for repointing the SessionStart hook off raw `bd prime`.
- 47843a4: beadsd now keeps its served clone fresh (GH-296): `runBeadsServe` runs an injected `refresh` on start and every 5 minutes, and `prx beads serve --cwd <clone>` wires that to `bd dolt pull` in the served clone. Refresh errors are swallowed (a stale-but-up daemon beats a crashed one); conflict resolution against local writes is left to the sync agent. So a long-lived local daemon no longer serves indefinitely-stale beads.

## 0.8.0

### Minor Changes

- 3ffdce8: GH-411 slice 5 (finale): **remove the deprecated `ai-home` env-name aliases** and
  flip the nix home-manager module to the neutral name. Breaking, by design.

  - `operator-config.ts` / `build-info.ts` / `prx-compile.ts`: drop the
    `PRX_AI_HOME_ROOT`, `BAKED_AI_HOME_ROOT`, `__PRX_BUILD_AI_HOME_ROOT__`, and
    `PRX_COMPILE_AI_HOME_ROOT` read-aliases. Only the neutral names
    (`PRX_OPERATOR_CONFIG_ROOT` / `BAKED_OPERATOR_CONFIG_ROOT` /
    `__PRX_BUILD_OPERATOR_CONFIG_ROOT__` / `PRX_COMPILE_OPERATOR_CONFIG_ROOT`) are
    read now.
  - `nix/hm-module.nix`: the `programs.prx.aiHomeRoot` option →
    `programs.prx.operatorConfigRoot` (exports `PRX_OPERATOR_CONFIG_ROOT`).

  **Breaking — consumer action required.** Any home-manager config that sets
  `programs.prx.aiHomeRoot` must rename it to `programs.prx.operatorConfigRoot`,
  and any shell/env that exported `PRX_AI_HOME_ROOT` must export
  `PRX_OPERATOR_CONFIG_ROOT`. Without the rename, `home-manager switch` fails with
  an unknown-option error.

### Patch Changes

- 7b12e6a: Remove dead code (knip): the unused `machine/{index,events,state,derive-phase,invariants}.ts` re-export shims and the never-wired `pr-state/personal_sprintx.ts`. The personal-sprint metric/goal model is captured as a backlog idea in #438 for a future, properly-wired implementation.
- c3a8b84: `BeadsResolver` (the canonical=bd hydrate path) now reads through beadsd (GH-296): the `BD-<8hex>` + external-ref snapshot scans use `loadAllBeadsViaDaemon` and the record fetch uses `showBeadViaDaemon`, instead of local `runBdShow`/`loadAllBeads`. Per the per-repo/single-workspace decision (one daemon = one repo; multi-tenant rejected), the resolver's `cwd` is vestigial — it routes to the single per-repo daemon. `toBdLongId` (used by `primePlanSession`'s canonical=bd fork) is now async.

## 0.7.4

### Patch Changes

- 6ab3bf8: Additive testability seams (behavior-preserving): the intake→triage default
  UoW reader is now built via `uowReaderWith(run = defaultRunner)`, and
  `runGhAuthStatus` / `runGhApiUserLogin` take an injectable `spawn` (defaults to
  the real proc). Production call sites pass nothing.
- 038eef8: GH-411 slice 3: make the `prx home update` / `prx upgrade` coupled flake-input
  set config-driven instead of hardcoding `ai-home`. The default now reads
  `homeUpdate.inputs` from `~/.config/prx/config.json` (e.g. `["prx", "ai-home"]`),
  falling back to `["prx"]` when unconfigured — prx always updates its own input.
  `prx upgrade` is now a thin pass-through (no baked `--input prx,ai-home`); an
  explicit `--input` / `PRX_HOME_FLAKE_INPUT` still overrides. Also resolves #21
  (home update now includes `prx`, not just the consumer).

  Operator note: to keep `prx upgrade` bumping the consumer flake, add
  `{"homeUpdate": {"inputs": ["prx", "ai-home"]}}` to `~/.config/prx/config.json`.

- c5c0f96: GH-411 slice 4: make the repo→commit-scope map config-driven instead of
  hardcoding `bdelanghe/ai-home`. `inferOperatorScopeFromCwd` (the `--scope`
  default for `prx intake`) now reads `scopeMap` from `~/.config/prx/config.json`
  (e.g. `{"scopeMap": {"owner/repo": "prx"}}`) — unconfigured → `no-mapping`, so
  the caller requires an explicit `--scope`. Adds a single shared operator-config
  reader (`operator-config.ts`: `readOperatorConfig` / `readOperatorConfigStringMap`)
  that `homeUpdate.inputs` (slice 3) now also uses, de-duplicating the config.json
  parse. Repo-identity doc examples in `registry_store.ts` / `beads/hydrate.ts`
  reworded off the personal repo to `example-owner/example-repo`.

  Operator note: to keep `prx intake` auto-scoping your repo, add
  `{"scopeMap": {"<owner>/<repo>": "prx"}}` to `~/.config/prx/config.json`.

- 5d4bacd: `scout read` signing is now fail-closed in a signing context (GH-352), mirroring `prx ci`: when a read is in scope of a provenance ledger (a reserved work-unit / pipeline) but no signer is configured, the read is refused with a clear message (`prx provenance setup` / `prx provenance status`) — an unsigned in-pipeline read is not trusted. A bare read outside a work-unit (no canonical ledger) is unaffected, and a transient signing-execution error when a signer IS configured stays best-effort (never drops the read).
- 12ac1f2: `prx plan search` and `prx intake search` now read beads through the beadsd daemon (GH-296): the case-insensitive title filter (`searchBd`) is refactored into a pure function over records, and the verbs load via `loadAllBeadsViaDaemon` (search is a legitimate scout-shaped aggregate read). No local `bd` in the search path. The local-only "bd list exited non-zero but emitted a valid array" tolerance no longer applies at the verb level — the daemon (server-mode dolt) owns the parse and that post-listing condition can't occur; bd-unreachable still degrades to GH-only.

## 0.7.3

### Patch Changes

- 3ed1866: Add the `reopen` kind to the beadsd write surface (GH-296 wave 2) — contract + daemon (`bd reopen <id>`, an allowed subcommand so it dispatches directly, unlike the policy-blocked `close`) + `reopenBeadViaDaemon` helper + `prx beads reopen <id>` CLI. This completes the **atomic** write contract (create / update / close / reopen); bulk reconcilers (promote / drift-fix) are left to a future sync agent.
- 7cd371a: Add `prx beads create|update|close` — the single-writer surface routed through beadsd (GH-296 wave 2). Like the read door, no `--vm` ⇒ local daemon (auto-started), `--vm` ⇒ the in-VM daemon. beadsd dispatches writes under the planner role/state so bd's policy allows them (it's the trusted single writer; per-caller authority is gated at the `prx beads` invocation layer). This gives humans and agents a working write path that targets the one canonical beads instead of a worktree's broken local `.beads`.
- 63ff3b5: Add `beadsd/writes.ts` — daemon-routed `createBeadViaDaemon` / `updateBeadViaDaemon` / `closeBeadViaDaemon`, the write twins of `beadsd/reads.ts` (GH-296 wave 2). These are the single-source replacements that internal `execBd` write call sites migrate onto, so host writes go to the one beads the daemon owns. A non-ok daemon verdict throws; the echoed bd record is parsed with the same transform the readers use.
- 26686e6: Extend the beadsd write contract with the fields the internal write call sites need (GH-296 wave 2 parity): `create` gains `externalRef` (`--external-ref`) + `silent` (`--silent`); `update` gains `issueType` (`--type`). Wired through the daemon `beadsArgs` dispatch and the `createBeadViaDaemon`/`updateBeadViaDaemon` helpers. Unblocks flipping `promote` / `intake-mirror` (create with an external ref) and `drift-fix` (update the type axis) onto the daemon.
- 4f75d13: `prx handoff` verbs (enqueue/status/drain/replay) gain an optional `deps` seam
  (store / drain / audit-row) defaulting to the real bd/CAS/audit
  implementations, so the verbs are unit-testable without a live bd substrate.
  Existing call sites pass nothing and are unaffected.
- d084274: The markdown-coverage guard now excludes any `CHANGELOG.md` (changesets-managed per-package release logs) generically, instead of only `packages/prx/CHANGELOG.md`. A release had added `packages/bd|gh|git/CHANGELOG.md`, which the guard flagged as uncatalogued and turned `ci` red on every PR.
- 91fb365: GH-411 slice 1: introduce a deployment-neutral operator-config root resolver
  (`operatorConfigRoot()` in `operator-config.ts`) and route the overlay-path
  resolution (`pr-state/github.ts`) and the wt-hook override resolution
  (`tools/run_hook.ts`) through it. New env names — `PRX_OPERATOR_CONFIG_ROOT`
  (runtime) and `BAKED_OPERATOR_CONFIG_ROOT` / `__PRX_BUILD_OPERATOR_CONFIG_ROOT__`
  (baked) — take precedence, with the old `PRX_AI_HOME_ROOT` / `BAKED_AI_HOME_ROOT`
  / `PRX_COMPILE_AI_HOME_ROOT` kept as deprecated aliases for one release so the
  nix wrapper and existing binaries keep working unchanged. First step toward
  running prx standalone without the hardcoded `ai-home` deployment repo.
- 2d66c67: GH-411 slice 2: rename the internal overlay identifiers off `ai-home` now that
  the resolver indirection (slice 1) is in place. `resolveAiHomeOverlayPath` →
  `resolveOperatorOverlayPath` (`pr-state/github.ts`), and the `aiHomeRoot`
  option field / locals → `overlayRoot` (`tools/run_hook.ts`,
  `tools/ensure_claude_settings.ts`). Pure internal rename — no behavior, env, or
  public-API change. Repo-identity literals (`bdelanghe/ai-home`) are slice 4.
- 51696b4: `prx provenance setup` (GH-352): promotes the signing-setup step into a first-class command — derive each actor's public key from the resolved master, publish the trust map, verify drift is clean, and report the resulting posture (idempotent; exits non-zero if drift remains). `setup-provenance-signing` is now a thin wrapper that adds a master file-perms preflight and delegates to it; the `prx provenance status` onboarding text and `docs/provenance/signing.md` point at the command.
- 75525e0: Hardened provenance signing setup (GH-352): `scripts/setup-provenance-signing` (one-command `keymaker register` + drift check + posture report), a `programs.prx.provenance` home-manager option (declaratively wires `PRX_PROVENANCE_MASTER_FILE` / per-actor `PRX_PROVENANCE_KEY` / `PRX_REQUIRE_SIGNED_DERIVATIONS`), and `docs/provenance/signing.md` (the operator-master runbook — sops/agenix → per-actor keys → committable trust map → fail-closed enforcement).
- 038c325: `prx provenance status` (GH-352): reports the signing posture — production / bootstrap / drifted / unconfigured — from the master source, per-actor mode, trust-map actor count + drift, and enforcement, and when it's not the production configuration bubbles up the exact onboarding next-steps. So a missing or stale signing setup is discoverable from inside prx, not just the docs. The `prx ci` fail-closed message now points at it.
- 10d9010: refactor: remove the `prx tmux reconcile` verb and its config-drift wiring (slice 1 of removing tmux entirely). Drops the tmux `gc` component/driver and the tmux reconcile embedding in `prx home update`. The reconcile path only existed to converge a live tmux server against rendered home-manager config; with tmux on its way out (headless-first + session-host substrate) it has no replacement. Interactive sessions, the parity surface, and the `prx-mux` package are removed in later slices.
- e4110d3: `prx triage close` now reads and closes through beadsd (GH-296 wave 2) instead of local `execBd`: a targeted `showBeadViaDaemon(<id>)` lookup + `closeBeadViaDaemon`, so the close lands on the one canonical beads. First internal write call-site flipped onto the daemon write helpers; `runTriageClose` is now async.

## 0.7.2

### Patch Changes

- 537a118: `prx ci` is now fail-closed on signing (GH-352): local dev is the production surface, so wherever a provenance ledger is in scope (a reserved work-unit, or `PRX_CI_LEDGER` in CI) and no `PRX_PROVENANCE_KEY` is set, the run fails with a clear, actionable message (`set PRX_PROVENANCE_KEY=dev` for the zero-config local signer, or `ed25519:<b64>` for a shared/CI key) instead of silently skipping. Outside a signing context it is unchanged. `.github/workflows/ci.yml` sets `PRX_CI_LEDGER` only when the secret is present, so the `ci` job stays green until remote signing is switched on.
- df7cb2e: Additive testability seams + a dead-code dedupe, all behavior-preserving:

  - `@bounded-systems/gh` — `execGh` gains optional `deps.spawn` / `deps.budget`
    seams so the rate-limit authority boundary is testable without a live `gh`
    spawn or real GitHub budget state. Existing call sites pass nothing.
  - `@bounded-systems/bd` — removed the redundant static `BLOCKED_SUBCOMMANDS`
    check (the policy `isBlocked` gate already enforced the identical list);
    policy is now the single source of truth, pinned by a `blockedSubcommands`
    parity test.
  - `@bounded-systems/prx` — `execWorktrunk`, `runClaudePreflight`, and
    `runHookVerb`/`readStdin` gain optional injectable spawn/exec/stdin seams
    (default to the real implementations) so their subprocess/stdin boundaries
    are unit-testable.

## 0.7.1

### Patch Changes

- b5fa4b1: `prx beads provision` (and `prx lima provision-beads`) now `chmod 700` the `.beads` directory it creates, so bd no longer warns about insecure `0755` permissions on the provisioned canonical clone.
- edf2fbb: `prx snapshot` now surfaces the CI provenance verdict + freshness in `DomainStateV1.ci` via a cached layer (GH-352): `prx ci` writes the verdict to `.pr/local/ci-provenance.json` while the ledger is open, and `snapshot` reads it synchronously and recomputes freshness against HEAD (`fresh` while the cached commit is still HEAD, `stale` once it moves) — so the read stays synchronous and ledger-free.
- 92cc8db: Make the test suite hermetic against the operator's git signing config. Many tests
  `git commit` throwaway fixture repos that fell back to the operator's global
  `~/.config/git/config` — which, with an interactive signer (e.g. 1Password SSH),
  fails headless and broke `prx ci` (and so the pilot's local `checking` gate,
  GH-360). The bun-test preload now points git's global/system config at a hermetic
  file (identity set, signing off), isolating fixture commits from the operator setup.

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
