# ADR — wiring the beadsd door into the claude-box pod (prx-asr / prx-634)

> Status: **proposed**. Consumes the already-merged prx-side gate
> ([#603](https://github.com/bounded-systems/prx/pull/603),
> [#604](https://github.com/bounded-systems/prx/pull/604) — `bdDoorGate` /
> `isBdDoorMode` in `packages/bd/src/index.ts`, the dialer in
> `packages/prx/src/beadsd/bd-door-dialer.ts`). Blocks on the OCI substrate
> (epic prx-zj8). No infra in this ADR is built yet; code references below to
> *existing* modules are real, references to the pod/image are the proposal.

## Problem

The merged gate flips bd-backed work into **door mode** when `PRX_BEADS_DOOR`
is set (`isBdDoorMode`): instead of spawning a local `bd`, `execBd` /
`defaultBdGithubRunner` / the proc wrappers dial the beadsd door or fail closed.
But **nothing sets `PRX_BEADS_DOOR`, and no beadsd is reachable inside
claude-box** — so today the gate never fires there, and a boxed `prx intake bd
ls` would still try (and fail) to exec a `bd` that prx-82b removed.

Two beads close that:

- **prx-634** — the `beadsd-box` image: a pinned OCI image running the beads
  daemon, connected to the external dolt store (a prx-zj8 slice).
- **prx-asr** — assemble the per-repo pod and wire the doors so claude-box can
  reach beadsd (and keeperd) over a unix socket, with `PRX_BEADS_DOOR` set.

This ADR specifies that wiring and how it lines up with the existing transport.

## Background: how a beads read reaches the daemon today

The door is a length-prefixed-JSON **unix-socket server**
(`packages/prx/src/keeperd/daemon.ts` `createServer` — beadsd mirrors keeperd's
shape). The host dials it through `unixSocketTransport(socketPath)`
(`packages/prx/src/keeperd/transport.ts`), and the endpoint is resolved from the
environment (`packages/prx/src/beadsd/client-factory.ts`
`resolveBeadsEndpoint`):

- `PRX_BEADS_VM` → reach beadsd inside a Lima VM (SSH-forwarded socket);
- else **local unix socket** at `PRX_BEADS_SOCKET` (default
  `/tmp/prx-beadsd.sock`).

The dialer the gate registers (`prxBeadsDoorDialer`) does **not** open a socket
itself — it spawns `prx beads <verb>` as a subprocess, and *that* process runs
`withBeadsClient` → `resolveBeadsEndpoint` → `unixSocketTransport`. So the door
mode flag (`PRX_BEADS_DOOR`) and the transport address (`PRX_BEADS_SOCKET`) are
**two separate env vars** that the pod must set together.

## Decision

### 1. Pod topology — one per-repo pod, sibling daemons, socket doors

A per-repo **podman pod** (one daemon = one repo; see the per-repo-no-multitenant
constraint) holds three containers:

```
┌─ pod: prx-<repo> ────────────────────────────────────────────┐
│  claude-box        beadsd-box            keeperd-box          │
│  (the agent)       (prx-634)             (prx-anj)            │
│      │                  │                     │               │
│      │  PRX_BEADS_DOOR  │  serves             │  serves        │
│      └───── unix socket ┘  /run/prx/doors/    └── git-write ──┘│
│                            beadsd.sock           door          │
│                                                                │
│   shared door dir: tmpfs volume mounted into each container    │
└────────────────────────────────────────────────────────────────┘
                              │ connect-to-external-dolt
                              ▼
                     dolt store (outside the pod)
```

- The **doors are unix sockets** on a shared `tmpfs` volume (e.g.
  `/run/prx/doors/`) mounted into the containers. No network ingress — matches
  the Tailscale-only / no-listening-port posture (prx-9yv3). beadsd binds
  `/run/prx/doors/beadsd.sock`; claude-box mounts the same volume.
- The socket file mode is `0700`, owned by the pod's uid — the door is the
  *only* beadsd ingress into claude-box.

### 2. The door env contract (what prx-asr injects into claude-box)

The pod assembler exports **both** vars into the claude-box container env,
derived from one source (the door dir + name):

| Var | Value | Role |
| --- | --- | --- |
| `PRX_BEADS_DOOR` | `beadsd` (the door **name**) | flips `isBdDoorMode` → door mode; names the door in fail-closed messages |
| `PRX_BEADS_SOCKET` | `/run/prx/doors/beadsd.sock` (the **path**) | the address `resolveBeadsEndpoint` → `unixSocketTransport` actually dials |

`PRX_BEADS_DOOR` is the *box-profile signal* (its mere presence means "no local
bd; route through the door"); `PRX_BEADS_SOCKET` is the *transport address*.
Keeping them distinct preserves the gate's clean "am I in the box?" check while
reusing the existing endpoint resolver unchanged.

> **Open option (follow-up):** collapse the two by adding a
> `resolveDoorSocket(name)` helper so the pod sets only `PRX_BEADS_DOOR=beadsd`
> and the path is derived (`/run/prx/doors/${name}.sock`). Deferred — the
> two-var form needs no code change to the merged endpoint resolver.

### 3. The beadsd-box image (prx-634)

A pinned nix `dockerTools` OCI image (digest = the sha-pin; rootless podman),
containing:

- the `bd` binary (the daemon's own backend — *inside the beadsd container, not
  claude-box*; this does not violate prx-82b, which removes `bd` from the
  **agent** surface, not from the daemon that owns the single writer);
- `prx beads serve` (the daemon entrypoint binding the socket);
- **connect-to-external-dolt**: the dolt store lives outside the pod; the
  daemon connects to it (dolt sql-server / remote), so the image is stateless
  and the canonical store is shared, not per-container.

claude-box itself ships **without** a `bd` binary: AC #3 ("no local bd in the
box") is then enforced by *both* absence (nothing to exec) and the gate
(fails closed for door-inexpressible ops).

### 4. End-to-end, once wired

`prx intake bd ls` in claude-box → `execBd` sees `PRX_BEADS_DOOR` →
`bdDoorGate` → `prxBeadsDoorDialer` spawns `prx beads list` → `withBeadsClient`
→ `unixSocketTransport(/run/prx/doors/beadsd.sock)` → beadsd-box → external
dolt → rows back. Writes / memory / sql / admin / dolt-management ops have no
door read mapping → **fail closed** with the door-not-wired message (host-side
dolt/bootstrap management stays a keeperd/host concern, never routed).

## Rejected alternatives

- **Bundle `bd` in claude-box.** Rejected — contradicts prx-82b (remove the host
  bd) and re-creates the per-clone divergence GH-296 retired.
- **TCP to beadsd.** Rejected — a listening port is network ingress; the door is
  a unix socket on a shared volume, no port, matching the Tailscale-only posture.
- **One multi-tenant beadsd for all repos.** Rejected — one daemon = one repo
  (blast-radius / confused-deputy); cross-repo is many per-repo pods + a sync
  agent.
- **Make `execBd` async to dial the socket directly.** Rejected — `execBd` is
  synchronous and called deep in sync verb code; the dialer spawns `prx beads`
  (recursion-safe, mirrors `loadAllBeadsViaCli`) to keep the sync signature.

## Consequences

- The merged gate becomes *exercisable* in-box for the first time — the read
  surface (`list`/`ready`/`show`) works; everything else fails closed cleanly.
- Isolation is shared-kernel (pod), not VM — the known tradeoff carried from the
  OCI-runtime decision (epic prx-d4o); gVisor/runsc hardening is the separate
  isolation-tier bead (prx-5p5).
- keeperd-box (prx-anj, git-write door) is the symmetric sibling; its grant
  surface is prx-mlj. This ADR scopes only the **beads** door.

## Validation (since it can't run in-box yet)

- The prx-side gate is unit-proven off-profile and in door mode
  (`packages/bd/src/__tests__/runners.test.ts`,
  `packages/prx/test/beadsd/bd-door-dialer.test.ts`,
  `packages/prx/test/beadsd/bd-command-runner.test.ts`).
- First in-box smoke once prx-634/prx-asr land: `prx intake bd ls` returns the
  same rows as a host `prx beads list`, and `prx intake bd memory ls` fails
  closed naming the door — the two AC checks from the routing bead.
