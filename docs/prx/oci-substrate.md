# ADR — the prx OCI substrate: containerize the service fleet, retire the daemon-VM (prx-zj8)

> Status: **proposed** (capstone). The typed half of this is **built and merged**
> — the bd-door gate, the room/pod model, and the podman driver (see "Already
> built" below). This ADR specs the remaining **infra** half: the pinned OCI
> images and the runtime that assembles + runs them. None of the infra is built
> here — dockerTools images are Linux-only and the dev host is darwin with no
> Linux builder (prx-62h), so this is the design + concrete starting points, not
> a buildable slice. Companion ADRs: `claude-runtime.md` (prx-d4o, the agent
> runtime), `beadsd-door-wiring.md` (prx-asr, the door fabric).

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

Concrete starting point (beadsd-box; keeperd-box mirrors it), **not yet wired
into flake.nix and not buildable here** — replace every `TODO`:

```nix
# nix/beadsd-box.nix — STARTING POINT. Linux-only; validate on a Linux builder.
self: { pkgs, system ? pkgs.stdenv.hostPlatform.system, bins }:
let
  inherit (pkgs) lib;
  # bd is not in nixpkgs / not tracked here — fetch it FOD like nix/fetch-release.nix.
  bd = pkgs.runCommand "bd-TODO" { } ''
    mkdir -p "$out/bin"
    install -m755 ${pkgs.fetchurl {
      url = "https://example.invalid/bd-${system}"; # TODO: real bd release URL
      sha256 = lib.fakeSha256;                       # TODO: real sha256
    }} "$out/bin/bd"
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "beadsd-box";
  tag = bins.version;
  contents = [ bins.prx bd pkgs.dolt pkgs.cacert pkgs.git pkgs.coreutils ];
  extraCommands = "mkdir -p ./run/prx/doors ./var/lib/prx/beads";
  config = {
    # Foreground — confirmed. No init wrapper.
    Entrypoint = [ "prx" "beads" "serve"
      "--socket" "/run/prx/doors/beadsd.sock"
      "--cwd" "/var/lib/prx/beads" "--pidfile" "/run/prx/beadsd.pid" ];
    Env = [ "PATH=/bin" "PRX_BEADS_CWD=/var/lib/prx/beads" ];
    User = "1000:1000";
    WorkingDir = "/var/lib/prx/beads";
  };
}
# flake.nix (Linux-only so darwin still evaluates):
#   // lib.optionalAttrs pkgs.stdenv.isLinux {
#        beadsd-box = import ./nix/beadsd-box.nix self { inherit pkgs system bins; };
#      }
```

### 2. The build substrate — prx-62h (the builder-room)

dockerTools images are Linux-only; on darwin they need a Linux builder. That
builder is already modeled as `builderRoom` (a VM-tier room, prx-62h) exposing a
`nix:build`/`oci:image` door. prx-zj8 depends on prx-62h existing so the images
can be built (and on a darwin host, a `nix build --builders ssh://…` into it).

### 3. Assembly + runtime — prx-asr

The podman driver (#611) already renders the Pod manifest. The remaining runtime:

1. provision the per-repo pod's shared tmpfs door volume (`/run/prx/doors`);
2. `podman kube play <renderPodmanKube(perRepoPod)>` — start the pod;
3. the rendered env (`PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` on `claude-room`) makes
   the gate fire in-box; closed doors (`session:control`) stay unwired;
4. retire the Lima daemon-VM once the pod path is healthy.

### 4. The door-env contract — beadsd + keeperd wired

`podRoomEnv` projects the **beadsd** door (`PRX_BEADS_DOOR` + `PRX_BEADS_SOCKET`,
matching `resolveBeadsEndpoint`) and now the **keeperd** door (`PRX_KEEPER_DOOR` +
`PRX_KEEPER_SOCKET`, matching `resolveKeeperEndpoint` — `keeperd/endpoint.ts`).
So `claude-room`'s projected env carries both doors, and the keeper pair
round-trips through its resolver (closed-loop tested in `test/room/pod.test.ts`).
`PRX_KEEPER_DOOR` is the marker a future keeper-door gate reads (mirroring how
`PRX_BEADS_DOOR` flips the bd-door gate); `PRX_KEEPER_SOCKET` is the dial target.
Remaining: the wrapper that turns a resolved keeper endpoint into a live
`IsolatedKeeperClient` over the local unix-socket door (the transport already
exists in `door/transport.ts`; the Lima path is `keeperd/lima-transport.ts`).

## Open questions / TODOs

- **bd release artifacts** — URL + per-system sha256 (track in a hashes JSON).
- **external dolt** — the fork from `beadsd-door-wiring.md`: dolt sql-server
  in-box (stateful, simple) vs sibling container (stateless; recommended). The
  served clone is server-mode (`.beads/metadata.json` `dolt_mode: server` +
  `sync.remote` to dolthub); the connection must point at the chosen server.
- ~~**keeperd endpoint env** — define `PRX_KEEPER_*` so its door projects.~~
  Done (§4): `resolveKeeperEndpoint` + the `podRoomEnv` projection. Follow-on is
  the door-dialing `IsolatedKeeperClient` wrapper, not the env contract.
- **image registry refs** — `RoomSpec.image` carries the `-box` name today; the
  full registry ref (or local containerd load) is resolved at deploy.
- **isolation tier** — shared-kernel pod; gVisor/runsc hardening is prx-5p5.

## Sequencing

```
prx-62h  (Linux builder substrate — the builder-room)
   └─ prx-634 / prx-anj / prx-d4o  (the beadsd-box / keeperd-box / claude-box images)
        └─ prx-asr  (provision door volume + `podman kube play` the rendered pod)
             └─ retire the Lima daemon-VM
```

## Validation

The typed half is unit-tested and merged (`packages/prx/test/room/*`,
`packages/bd/src/__tests__/runners.test.ts`). The infra half cannot run here (no
podman, no Linux builder); first real validation is on a Linux builder: build an
image, `podman kube play` the rendered `perRepoPod`, and confirm `prx intake bd
ls` in `claude-room` returns the same rows as a host `prx beads list` — the AC
from the bd-door routing bead (prx-438).
