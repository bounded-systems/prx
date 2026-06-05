# `prx dolt start` — the dolt actor's start driver (GH-555)

> **Reviewed change — do not auto-merge.** This implements the engine + the
> missing detached-spawn primitive; three env-specific defaults need a
> maintainer's confirmation before it runs live (flags F1–F3 below).

## Why

The `dolt` actor is already modeled (`machine/actors.ts`: emits
`DOLT_SERVER_STARTED/HEALTHY/STOPPED/ORPHANED`, accepts `start/stop/status/…`),
but its lifecycle **drivers are stubbed** (`DOLT_VERB_DISPATCH.start →
dolt-stub`, GH-555). So in practice Dolt does *not* go through the actor for
start/stop — `bd` manages it directly, and when the local database is missing
every command fails with "database not found". This wires the `start` driver so
the actor can actually bring a per-repo dolt sql-server up.

## What's here

- **`@bounded-systems/proc` → `spawnDetached`** — the missing primitive. A
  sql-server is a daemon that must outlive the parent; `spawnCapture` runs to
  completion, so it's wrong for this. `spawnDetached` starts detached + unref'd
  and returns the pid. It's the sanctioned daemon-spawn point (the boundary
  tests forbid raw `child_process` elsewhere).
- **`packages/prx/src/dolt/start.ts` → `runDoltStart`** — the engine. Pure,
  fully injected (`DoltStartDeps`): resolve repo context → refuse to
  double-start (a reachable-but-unowned server routes to `prx dolt adopt`) →
  `spawnDetached` the server → poll to healthy → write the lifecycle ledger →
  return `StartOutput` (`started` | `exists`). Tested with fakes; **never spawns
  a live server in CI.**

## Reviewer flags (env-specific — confirm before a live run)

- **F1 — server argv.** `buildServerArgv` → `dolt sql-server --data-dir <dir>
  --host 127.0.0.1 --port 3307`. Best reading of the code; confirm the flags
  (config file? auth? socket?) bd expects.
- **F2 — discovery.** The health probe goes through `bd dolt show`, so a
  prx-started server only registers if **bd is pointed at the same port**.
  Confirm the bd↔prx port coordination, or swap `defaultProbe` for a direct
  TCP/dolt check on the chosen port. (3307 is what `bd bootstrap` probed.)
- **F3 — database name.** `defaultDeriveDatabase("owner/repo") →
  "io_github_owner_repo"`. Confirm it matches bd's canonical reverse-DNS naming.

## Remaining wiring (not in this PR)

- Flip `DOLT_VERB_DISPATCH.start` route `dolt-stub → dolt-start` and add the
  `dolt-start` command variant + parse + handler in `pr-state/cli.ts` (mirrors
  the existing `dolt-status` path). Left out deliberately — it's mechanical but
  touches the large CLI dispatch, and is best done once F1–F3 are confirmed.
- Once `start` works: a live `bd bootstrap` clones the database into the running
  server, unblocking `PRX_PILOT_REAL=1 prx pilot <unit>`.
