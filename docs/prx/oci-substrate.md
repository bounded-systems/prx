# ADR — the prx OCI substrate: containerize the service fleet, retire the daemon-VM (prx-zj8)

> Status: **built + validated** (the per-repo pod runs). The typed half (bd-door
> gate, room/pod model, podman driver) and the infra half (the `-box` images, the
> `playPod`/`downPod` runtime, the repo + door wiring) are merged. On
> 2026-06-15/16 the full `perRepoPod` was played on podman with **all three rooms
> Up and both daemons serving** (see "Validation"). What remains is operational
> hardening, not assembly — see "Remaining". Companion ADRs: `claude-runtime.md`
> (prx-d4o, the agent runtime), `beadsd-door-wiring.md` (prx-asr, the door fabric).

## Problem

The prx service fleet (beadsd, keeperd) runs today inside a Lima **daemon-VM**.
The target is **pinned OCI images on podman** — a per-repo pod of containers —
so the boxed agent reaches its capabilities through real, isolated doors and the
runtime is a content-addressed sha-pin, not a mutable VM. prx-zj8 is that
substrate; it unblocks the gate (which is inert until a door is reachable in the
box) and the whole room/pod model.

## Built (merged)

The chain **Room declares a door → Pod resolves it → driver renders a pod →
runtime plays it → daemons serve their doors** is real, end to end:

- **bd-door gate** (#603/#604) — `execBd` / `defaultBdGithubRunner` / the proc
  wrappers route bd work through the beadsd door (or fail closed) when
  `PRX_BEADS_DOOR` is set; off-profile is byte-identical.
- **room/pod model** (#606, #614) — `RoomSpec` (occupant + doors + open/closed
  state + `image`) and `PodSpec` (holds rooms, the house, the door fabric,
  `resolvePodDoors`, `podRoomEnv`).
- **podman driver** (#611) — `renderPodmanKube(pod)` → a `podman kube play`
  manifest: rooms→containers (real `-box` images), the shared tmpfs door volume,
  per-room door env.
- **the `-box` images** — `nix/oci/{beadsd,keeperd,dolt}-box.nix` (#617/#620/#623),
  pinned `dockerTools` images on the prx-62h builder (§1).
- **door env contract** — `resolveKeeperEndpoint` + the `podRoomEnv` keeperd
  projection (#626), and `withKeeperClient` (#628) — keeperd is wired symmetric
  to beadsd (§4).
- **the runtime** — `room/podman-runtime.ts` `playPod`/`downPod` (#630) +
  the repo `/work` mount in the manifest (#631, §3).
- **prx-runnability** — the `bun --compile` release binary now actually runs in
  the from-scratch images (#632, prx-hqqw, §1).

## Decision

### 1. The image set — pinned `dockerTools` OCI images (rootless podman)

One image per daemon room, each a pinned nix `dockerTools.streamLayeredImage`
(digest = the sha-pin), built from a pinned nixpkgs. Live in `nix/oci/` and are
flake outputs under `lib.optionalAttrs pkgs.stdenv.isLinux` (so darwin still
evaluates); build with `nix build .#packages.aarch64-linux.<box>`.

- **beadsd-box** (prx-634, #617) — `prx beads serve` + `bd` (built **from source**,
  `nix/oci/bd.nix` via `buildGoModule` + icu for its dolt cgo dep) + `dolt`.
- **keeperd-box** (prx-anj, #620) — `prx keeper serve` + git + the provenance
  signing key as a **runtime secret** (read from a mounted tmpfs path into
  `PRX_PROVENANCE_KEY` by the entrypoint, never baked into a layer).
- **dolt-box** (#623) — the per-repo dolt SQL server.
- **claude-box** (prx-d4o, see `claude-runtime.md`) — the agent runtime; built
  in the separate `claude-box` repo (`nix build .#claude-image` → `claude-personal`).

**prx-runnability (prx-hqqw, #632) — the hard-won bit.** The images ship the
*fetched* released prx, which is a `bun --compile` single-file executable (a Bun
runtime with the app blob appended after the ELF) and is FHS-dynamically-linked.
In a from-scratch image it fails two ways, both fixed in `nix/oci/prx-fhs.nix`
(+ `fakeNss`/`HOME` in each image):

1. **No `/lib` loader / `patchelf` corrupts the blob.** `autoPatchelf` rewrites
   the (longer nix) interpreter, grows the file, and corrupts the appended blob →
   the binary degrades to **bare Bun**. So the bytes must be left **byte-intact**
   and the nix glibc loader invoked *directly with the binary as an argument*
   (mirroring the `claude-box` flake): `ld-linux-<arch>.so --library-path
   <glibc:libstdc++> /libexec/prx "$@"` (Bun then locates its blob via argv).
2. **`uv_os_homedir`.** Once prx runs, `os.homedir()` crashes `ENOENT` with no
   `/etc/passwd`/`HOME`. Fix: `dockerTools.fakeNss` + `HOME=/home/prx`.

> Gotcha for future debugging: `prx --version` is a **red herring** — Bun
> intercepts `--version` and prints *its own* version even when the app is fine.
> Probe with `prx --help` or a real verb.

### 2. The build substrate — prx-62h (the Linux builder)

`dockerTools` images are Linux-only; on darwin they build via a registered
`aarch64-linux` remote builder. The Lima devshell VM
(`bdelanghe-lima-devshell-main`) is registered in `/etc/nix/machines`, so
`nix build .#packages.aarch64-linux.<box>` offloads transparently — the earlier
"darwin has no Linux builder" caveat was wrong. prx-62h's remaining scope is to
make prx *own* that builder's supervision/registration rather than the ad-hoc
machines entry. (Loading a `streamLayeredImage` output on darwin: it's a
linux-arch stream script, so run it *inside* the Lima VM and pipe to podman —
`limactl shell <vm> <stream-script> | podman load`. `buildLayeredImage` tarballs
load directly.)

### 3. Assembly + runtime — prx-asr

`room/podman-runtime.ts` `playPod`/`downPod` pipe `renderPodmanKube(pod)` into
`podman kube play -` / `podman kube down -` through the `@bounded-systems/proc`
seam (injected runner ⇒ offline-tested; a non-zero exit → typed
`PodmanRuntimeError`). The volumes:

1. **the door fabric** — handled by the manifest: `renderPodmanKube` declares one
   `emptyDir{ medium: Memory }` mounted into every room, so `podman kube play`
   provisions it (no separate volume step);
2. **the repo at `/work`** (prx-u5lx, #631) — `PodSpec.repo` (the host repo path,
   deploy-time) → a `hostPath` volume mounted at `/work` in every room. The daemon
   images' `WorkingDir` is `/work`; without it podman/crun won't start them.

### 4. The door-env contract — beadsd + keeperd wired

`podRoomEnv` projects both doors: **beadsd** (`PRX_BEADS_DOOR` +
`PRX_BEADS_SOCKET`, read by `resolveBeadsEndpoint` + the bd-door gate) and
**keeperd** (`PRX_KEEPER_DOOR` + `PRX_KEEPER_SOCKET`, read by `isKeeperDoorMode` +
`resolveKeeperEndpoint`, #626). `withKeeperClient` (#628) assembles a live
`IsolatedKeeperClient` from the projected env via `resolveFramedTransport`. So
`claude-room`'s env carries both doors.

## Remaining (operational, not assembly)

- **keeper signing-key (host-backed secret) — a runtime SPLIT** (prx-b44y). The
  keeperd-box entrypoint already reads `/run/secrets/keeper-key` into
  `PRX_PROVENANCE_KEY`, so the image side is done — but **`podman kube play`
  cannot mount a host-created podman secret** (verified: *"only secrets created
  via the kube yaml file are supported"* — i.e. only in-YAML k8s Secrets, which
  would base64 the key into the manifest, violating "never in a plaintext
  layer/manifest"). Decision (operator): secrets come from a **host-backed**
  store (podman secret, encrypted at rest → tmpfs), not a plaintext file and not
  the manifest. So the secret-holding daemons run via `podman run --secret` /
  a podman **quadlet** (the runtime claude-box's doors NixOS module already
  uses), exposing their door on the shared `/run/prx/doors` fabric; the
  `renderPodmanKube` pod stays for the agent + non-secret rooms. A push
  credential is a host-backed secret on the same path.
- **beads-clone provisioning** — beadsd needs an initialized beads clone /
  external-dolt endpoint at its cwd for real reads (the daemon serves without it,
  but answers nothing).
- ~~**pipeline wiring**~~ — done (#634): `runSubmitPublish` routes the push
  through the keeper door under `isKeeperDoorMode` (`runKeeperDoorPush` →
  `withKeeperClient`); the requireSigned gate verifies the daemon's
  `signedDerivation`. Live in-daemon push waits on the key/credential above.
- **external dolt** — dolt sql-server in-box vs the sibling `dolt-box`; the served
  clone is server-mode (`.beads/metadata.json` `dolt_mode: server` + `sync.remote`),
  the connection must point at the chosen server.
- **image registry refs** — `RoomSpec.image` carries the `-box` short name; the
  full registry ref (or local containerd load) is resolved at deploy.
- **isolation tier** — shared-kernel pod; gVisor/runsc hardening is prx-5p5.
- **retire the Lima daemon-VM** — ✅ done (prx#824/#825/#828): removed the in-VM
  daemon code (`prx lima up|down|daemons|status|provision-beads`, `keeper up|down`,
  the `--vm`/`PRX_BEADS_VM` beads path, and the `lima/{registry,lifecycle,channel}`
  + `beadsd/provision` + `keeperd/lima-keeperd` + `ghappd/lima-ghappd` modules).
  The Lima VM **remains as the nix remote builder** (`prx lima provision-builder`,
  prx-62h). Removing the host bd/dolt install is the separate endgame, prx-82b.

## Sequencing (done)

```
prx-62h  Linux builder (Lima VM as remote builder)        ✅ works
   ├─ prx-634 beadsd-box  ✅ #617      ├─ prx-anj keeperd-box ✅ #620
   ├─ dolt-box ✅ #623                 └─ prx-d4o claude-box  ✅ (claude-box repo)
        └─ prx-asr  runtime ✅ #630 + /work ✅ #631 + door env ✅ #626/#628
             + prx-runnability ✅ #632
                  └─ retire the Lima daemon-VM   ✅ #824/#825/#828 (builder VM stays)
```

## Validation

The typed half is unit-tested and merged (`packages/prx/test/room/*`,
`packages/bd/src/__tests__/runners.test.ts`). The **infra half runs here**: on
2026-06-15/16 the real `perRepoPod` (`repo`=the worktree) was played on
`podman-machine-default` and **all three rooms came Up**, with both daemons
serving on the shared door fabric:

```
prx-pod
├─ claude-room   (claude-box)   Up   env: PRX_BEADS_SOCKET, PRX_KEEPER_SOCKET
├─ beadsd-room   (beadsd-box)   Up   beadsd:  listening on /run/prx/doors/beadsd.sock
└─ keeperd-room  (keeperd-box)  Up   keeperd: listening on /run/prx/doors/keeperd.sock
```

`downPod` tears it cleanly down. The remaining end-to-end AC — `prx intake bd ls`
in `claude-room` returning the same rows as a host `prx beads list` (prx-438) —
waits on the beads-clone provisioning above.
