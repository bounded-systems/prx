# ADR — the prx OCI substrate: containerize the service fleet, retire the daemon-VM (prx-zj8)

> Status: **proposed** (capstone), now **partially built**. The typed half is
> **built and merged** — the bd-door gate, the room/pod model, the podman driver
> (see "Already built" below). The first **image** is also built + validated:
> **beadsd-box** (prx-634) on the registered Linux remote builder (see §1). What
> remains: keeperd-box (prx-anj), and pod assembly + retiring the Lima VM
> (prx-asr). The earlier "darwin has no Linux builder" caveat was wrong — the
> dev host registers the Lima devshell VM as an `aarch64-linux` remote builder,
> so the images build from darwin. Companion ADRs: `claude-runtime.md` (prx-d4o,
> the agent runtime), `beadsd-door-wiring.md` (prx-asr, the door fabric).

## Problem

The prx service fleet (beadsd, keeperd) runs today inside a Lima **daemon-VM**.
The target is **pinned OCI images on podman** — a per-repo pod of containers —
so the boxed agent reaches its capabilities through real, isolated doors and the
runtime is a content-addressed sha-pin, not a mutable VM. prx-zj8 is that
substrate; it unblocks the gate (which is inert until a door is reachable in the
box) and the whole room/pod model.

## Already built (the typed half — merged)

The agent-facing contract is done; only the substrate it runs on is missing:

- **bd-door gate** (#603/#604) — `execBd` / `defaultBdGithubRunner` / the proc
  wrappers route bd work through the beadsd door (or fail closed) when
  `PRX_BEADS_DOOR` is set; off-profile is byte-identical.
- **room/pod model** (#606) — `RoomSpec` (occupant + doors + open/closed state +
  `image`) and `PodSpec` (holds rooms, owns the house + door fabric,
  `resolvePodDoors`, and `podRoomEnv` which projects `PRX_BEADS_DOOR` /
  `PRX_BEADS_SOCKET` — the gate's signal).
- **podman driver** (#611, #614) — `renderPodmanKube(pod)` renders a `PodSpec` to
  a `podman kube play` manifest: rooms→containers (real `-box` images), one
  shared tmpfs door volume, per-container env from `podRoomEnv`.

So the chain **Room declares a door → Pod resolves it → driver renders a pod
whose `claude-room` env fires the gate** exists as typed, tested code. prx-zj8
makes that manifest *runnable*.

## Decision

### 1. The image set — pinned `dockerTools` OCI images (rootless podman)

One image per daemon room, each a pinned nix `dockerTools` image (digest = the
sha-pin), built from a pinned nixpkgs. They share a common builder helper.

- **beadsd-box** (prx-634) — `prx beads serve` + `bd` + `dolt`; connects to the
  dolt store. `prx beads serve` runs **foreground** (it binds the socket and
  holds the listening `Server`; `--pidfile` only records the pid — confirmed
  from `runBeadsServe`), so it is a valid container PID 1, no init wrapper.
- **keeperd-box** (prx-anj) — `prx keeper serve` + git + the signing key as a
  runtime secret. Mirrors beadsd-box.
- **claude-box** (prx-d4o, see `claude-runtime.md`) — the agent runtime; ships
  **without** `bd`/`git`, so AC #3 ("no local bd in the box") holds by absence +
  the gate.

**beadsd-box is built — `nix/beadsd-box.nix` + `nix/fetch-bd.nix`, wired into
`flake.nix`** under `lib.optionalAttrs pkgs.stdenv.isLinux` (so darwin still
evaluates). The earlier "no Linux builder, not buildable here" blocker was wrong:
the dev host has a **registered `aarch64-linux` remote builder** (the Lima
devshell VM, `/etc/nix/machines`), so the image builds + validates from darwin:

```sh
nix build .#packages.aarch64-linux.beadsd-box   # offloads to the linux-builder
```

Two realities the minimal-image surface forced (both fixed in `beadsd-box.nix`):

- **`bd` is pinned hermetically** (`nix/fetch-bd.nix`) — per-system FOD fetch of
  the `gastownhall/beads` release tarball (v1.0.3, sha256 per linux system),
  replacing the unpinned `curl … | tar` in `packages/prx/src/beadsd/provision.ts`.
- **The released prx/bd binaries are FHS-dynamically-linked** (Bun/Go expecting
  `/lib/ld-linux-…`), which a `dockerTools` image lacks. They are run through
  `autoPatchelfHook` (glibc + libstdc++) so they execute in the image. dolt is
  nix-built and already store-patched.
- **`dockerTools.fakeNss` + `HOME`** — dolt/git need a uid-0 `/etc/passwd` entry
  and a writable home (set to the beads volume).

Validated end-to-end (2026-06-15): image built on the remote builder →
`podman load` → all four binaries run under aarch64 Linux (prx v0.9.0, bd 1.0.3,
dolt, git 2.54.0) → the default entrypoint comes up as PID 1 and logs
`beadsd: listening on /run/prx/doors/beadsd.sock`, with the socket bound in
`/run/prx/doors/`.

Open follow-ups (not blockers for the image itself):

- **dolt version** — the image uses nixpkgs `dolt` (2.1.x); the provision recipe
  pinned 1.86.2. Confirm bd↔dolt compat on the live `bd dolt commit/pull/push`
  reconcile path (needs a real dolt remote — see open questions).
- **non-root** — runs as root for now; non-root + volume ownership land with
  prx-asr / prx-5p5 where the door tmpfs and beads volume define ownership.

keeperd-box (prx-anj) mirrors this shape (`prx keeper serve` + git + the signing
key as a runtime secret); it is the next image, in its own PR.

### 2. The build substrate — prx-62h (the builder-room)

dockerTools images are Linux-only; on darwin they need a Linux builder. One
already exists and works: the Lima devshell VM is registered as an
`aarch64-linux` remote builder in `/etc/nix/machines`, so `nix build
.#packages.aarch64-linux.beadsd-box` from darwin offloads transparently (no
per-build `--builders` flag). prx-62h's remaining scope is to make prx *own* that
builder's supervision + registration (the `builderRoom`, a VM-tier room exposing
a `nix:build`/`oci:image` door) rather than relying on the ad-hoc `/etc/nix/machines`
entry. The images build today regardless.

### 3. Assembly + runtime — prx-asr

The podman driver (#611) already renders the Pod manifest. The remaining runtime:

1. provision the per-repo pod's shared tmpfs door volume (`/run/prx/doors`);
2. `podman kube play <renderPodmanKube(perRepoPod)>` — start the pod;
3. the rendered env (`PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` on `claude-room`) makes
   the gate fire in-box; closed doors (`session:control`) stay unwired;
4. retire the Lima daemon-VM once the pod path is healthy.

### 4. The door-env contract — beadsd wired, keeperd pending

`podRoomEnv` projects the **beadsd** door (`PRX_BEADS_DOOR` + `PRX_BEADS_SOCKET`,
matching `resolveBeadsEndpoint`). **keeperd has no client-endpoint env** (no
`PRX_KEEPER_SOCKET` analog), so its door projects nothing yet — defining that env
is a prerequisite before keeperd reads/writes route through its door in-box.

## Open questions / TODOs

- **bd release artifacts** — URL + per-system sha256 (track in a hashes JSON).
- **external dolt** — the fork from `beadsd-door-wiring.md`: dolt sql-server
  in-box (stateful, simple) vs sibling container (stateless; recommended). The
  served clone is server-mode (`.beads/metadata.json` `dolt_mode: server` +
  `sync.remote` to dolthub); the connection must point at the chosen server.
- **keeperd endpoint env** — define `PRX_KEEPER_*` so its door projects.
- **image registry refs** — `RoomSpec.image` carries the `-box` name today; the
  full registry ref (or local containerd load) is resolved at deploy.
- **isolation tier** — shared-kernel pod; gVisor/runsc hardening is prx-5p5.

## Sequencing

```
prx-62h  (Linux builder substrate)  ✅ works ad-hoc (Lima VM registered as remote builder);
   │                                    prx-owned supervision/registration still TODO
   ├─ prx-634  beadsd-box   ✅ built + validated (nix/beadsd-box.nix + nix/fetch-bd.nix)
   ├─ prx-anj  keeperd-box  ◻ next (mirrors beadsd-box + signing key as runtime secret)
   └─ prx-d4o  claude-box   ◻
        └─ prx-asr  (provision door volume + `podman kube play` the rendered pod)
             └─ retire the Lima daemon-VM
```

## Validation

The typed half is unit-tested and merged (`packages/prx/test/room/*`,
`packages/bd/src/__tests__/runners.test.ts`). The infra half **does** run here:
beadsd-box was built on the Lima remote builder, `podman load`ed into
`podman-machine-default`, and its entrypoint confirmed serving (PID 1, socket
bound). The remaining end-to-end AC — `podman kube play` the rendered
`perRepoPod` and confirm `prx intake bd ls` in `claude-room` returns the same
rows as a host `prx beads list` (prx-438) — waits on keeperd-box + prx-asr.
