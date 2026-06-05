# `prx dolt start` — the dolt actor's start driver (GH-555)

> The `start` driver, wired and working as an actor. It **mediates bd** (which
> owns the dolt server), so it's safe; one seam (F3, the db name) is worth a
> confirming glance.

## Why

The `dolt` actor is modeled (`machine/actors.ts`: emits
`DOLT_SERVER_STARTED/HEALTHY/STOPPED/ORPHANED`, accepts `start/stop/status/…`),
but its lifecycle **drivers were stubbed** (`DOLT_VERB_DISPATCH.start →
dolt-stub`, GH-555). So Dolt didn't actually go through the actor for start —
and when the server lifecycle wedged (stale lock + leaked servers + a corrupted
working set), every command failed with "database not found." This wires the
`start` driver so the actor owns the entry point.

## Design: the actor mediates bd

bd owns the per-repo dolt server lifecycle (`bd dolt start/stop`); a competing
prx-spawned server hits *"database is locked by another dolt process."* So the
actor **delegates to bd** rather than racing it:

- default `spawnServer` → `bd dolt start` (parses its `PID …` line);
- the probe → `bd dolt show` (bd is the authoritative source of truth);
- the actor adds its own lifecycle ledger + `StartOutput` + provenance on top.

**Verified live:** against a repo whose bd server was already up, `prx dolt
start` probed `:52490`, detected the server isn't prx-owned, and routed to `prx
dolt adopt` — the correct mediated behavior, no double-start.

## What's here

- **`@bounded-systems/proc` → `spawnDetached`** — a general daemon-spawn
  primitive (detached + unref'd, returns the pid). Not used by the default
  bd-delegating path, but it's the sanctioned spawn point for a future
  prx-owned standalone server (`spawnDetached(buildServerArgv(...))`).
- **`packages/prx/src/dolt/start.ts` → `runDoltStart`** — the engine. Pure,
  fully injected (`DoltStartDeps`): resolve context → refuse double-start
  (reachable-but-unowned → `adopt`) → start (delegating to bd) → poll healthy →
  write ledger → `StartOutput` (`started` | `exists`). Tested with fakes.
  `runDoltStartCli` is the thin CLI entry.
- **CLI dispatch** — `DOLT_VERB_DISPATCH.start` flipped `dolt-stub → dolt-start`;
  the `dolt-start` command variant + parse + handler added in `pr-state/cli.ts`
  (mirrors `dolt-status`). `prx dolt start [--repo-path .] [--format json]`.

## One seam to confirm

- **F3 — database name.** `defaultDeriveDatabase("owner/repo") →
  "io_github_owner_repo"` (for the dsn/ledger). This session's errors named
  exactly `io_github_bounded_systems_prx`, which this produces — so it's almost
  certainly right, but worth confirming against bd's canonical naming for other
  repos.

## After this lands

`prx dolt start` is the actor-owned entry to bring a per-repo server up (or
adopt/report an existing one) — the clean one-liner that the forensic recovery
this session had to do by hand.
