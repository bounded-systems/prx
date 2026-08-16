# ADR — the Claude runtime as a pinned OCI fleet (prx-d4o / prx-zj8)

> Status: **proposed**. No code yet — the flake builds only the fetched release
> binary (`nix/fetch-release.nix`, exposed as `packages.prx`); there is no
> `dockerTools` output, no podman wiring, and the daemons still run in the Lima
> VM (`packages/prx/src/lima/`, `packages/prx/src/beadsd/provision.ts`,
> `packages/prx/src/keeperd/lima-keeperd.ts`). This ADR is the spec the slice
> beads (prx-634 / prx-anj / prx-asr) are cut against. The one piece that is
> **already built** is the door transport this design leans on — see
> [Doors become localhost](#doors-become-localhost).

## Problem

prx runs an agent (Claude) plus a fleet of privileged daemons — `keeperd`
(git-writes + the provenance signing key), `beadsd` (the beads dolt clone),
`dolt` (the beads DB) — and today the daemon fleet lives in an
**imperatively-provisioned Lima VM**:

- `packages/prx/src/beadsd/provision.ts` installs `bd`/dolt into the VM by
  running a shell recipe over `limactl`;
- `packages/prx/src/keeperd/lima-keeperd.ts` + `lima-exec.ts` start keeperd in
  that same VM and bridge its unix socket out;
- `packages/prx/src/lima/lifecycle.ts` owns the VM's create/start/stop.

Two problems compound:

1. **The VM is not content-addressed.** It is a mutable host built by a
   provisioning script. There is no digest that says "this is *exactly* the
   beads daemon we ran" — which is at odds with prx's whole thesis (signed,
   pinned, content-addressed artifacts; see `docs/prx/ci-as-derivation.md`).
2. **The agent and the daemons are split across a VM boundary**, so every door
   (keeper, beads) has to be bridged out of the VM over a forwarded socket or a
   `host.containers.internal` TCP hop. The transport carries accidental
   complexity that exists only because of where the processes happen to run.

Meanwhile the **personal Claude runtime** (prx-d4o) needs an isolation boundary
too — running an autonomous agent with credentials on the host is the thing the
whole capability model exists to avoid (see
[[prx-claude-runtime-oci-container]] and the capability-orchestrator doc). The
question "VM or container for Claude?" and "how do we stop hand-building the
daemon VM?" are the same question.

## Decision

**Every long-running prx process is a pinned OCI image, and per repo they run
as containers in one rootless podman pod.**

- **Image build: `nix dockerTools.streamLayeredImage` from pinned nixpkgs.** The
  image digest (`sha256:…`) *is* the "sha we can pin to" — content-addressed by
  construction, which is exactly the property the Lima VM lacked. The agent
  toolchain image (claude-code + git + gh + ripgrep + bun + prx) and each daemon
  image (`dolt`, `bd`/beads, `keeperd` = the pinned aarch64-linux prx) are all
  built this way. A closure-copy of the nix store is **not** an OCI image and
  does not get a digest — `dockerTools` is the load-bearing choice.
- **Runtime: rootless podman, daemonless.** No root daemon, aligns with the
  ocap posture; later the same images can run in the VM's `containerd`/`nerdctl`
  if we want build+run colocated (see [Build substrate](#build-substrate)).
- **Per repo, one pod.** One pod per repo holds `{dolt-box, beadsd-box,
  keeperd-box}` plus the joining `claude-box`. This preserves the
  one-daemon-one-repo rule ([[prx-beadsd-per-repo-no-multitenant]]) — a pod is
  the unit of co-tenancy, not a multi-tenant daemon.

This **reshapes** prx-5ed (prx owns the *VM* lifecycle → prx owns the *image
fleet* lifecycle) and **supersedes** the VM-runtime framing of prx-bst
(session-host-in-VM) for the Claude runtime specifically.

### Why a container, not a VM (and the honest caveat)

A container is lighter, builds reproducibly from the flake, and gets a digest.
The honest caveat, which this ADR does **not** paper over: a shared-kernel
container is a weaker isolation boundary than a VM
([[prx-capability-enforcement-level]] — prx's ocap is source/lint-tier
discipline, not OS isolation). Two consequences are accepted and tracked
separately, not solved here:

- **macOS has no native Linux kernel**, so podman itself runs in a
  `podman machine` (a small Linux VM). "Container not VM" means *the unit of
  pinning and isolation is the image*, not that there is literally no VM on a
  Mac.
- **Stronger isolation is a follow-on, not a prerequisite**: gVisor/`runsc`
  (prx-5p5), Kata (the `docs/spikes/kata-containers-isolation-boundary.md`
  spike), or Firecracker microVMs (prx-n8d) can wrap the same images later. The
  image contract does not change when the isolation tier does.

### Doors become localhost

This is the part that is **already implemented** and the reason the design pays
off. `packages/prx/src/keeperd/transport.ts` (#601, prx-o92) already parses a
door endpoint string into the right transport with no per-door code:

```
parseDoorEndpoint("/run/keeperd.sock")              → unix   (mounted socket)
parseDoorEndpoint("host.containers.internal:3002")  → tcp    (host-gateway, macOS)
parseDoorEndpoint("localhost:3002")                 → tcp    (pod-local)
```

A podman pod shares one network namespace, so **inside the pod every door is
`localhost:PORT`** — the `pod-local` branch above. The cross-VM bridge
(`ssh -L` / `limactl` socket forwarding in `keeperd/lima-transport.ts`) exists
only to cross the VM boundary; collapsing the agent and the daemons into one pod
makes that bridge unnecessary. **The transport problem dissolves — we do not
build new transport, we delete a hop.** The bd door dialer
(`packages/prx/src/beadsd/bd-door-dialer.ts`, #601–604) is the proof of the
pattern: bd-backed verbs already route through a door rather than spawning `bd`.

### Secrets: the keeper signing key is a runtime secret

The one genuinely sensitive piece. The keeper provenance **signing key must
never be baked into an image or written to a plaintext volume.** Images are
content-addressed and may be cached/copied; a key in a layer is a key leaked.
The key is injected at run time (podman secret / 1Password → tmpfs mount) into
`keeperd-box` only. `claude-box` holds **no** credentials by design
([[prx-mlj]] is the capability grant): it can *request* a signed push through
the keeper door, but cannot push directly because it holds no key. This mirrors
beads→beadsd ([[prx-beadsd-door-bd-routing]]) — keeperd is the git twin.

### State: named volumes, not VM disk

The dolt DB and the beads clone move from the VM's disk to **named podman
volumes**, migrated from the VM or re-cloned from the dolt remote. The repo
worktree is a bind-mount (`claude-box --repo <path>`). Stateful data is the
volume; the image stays immutable.

### Build substrate

aarch64-linux/OCI images cannot be built on a macOS host directly. prx-62h owns
a single Linux builder, registered once into the nix builder set so every
`nix build` offloads transparently. The pragmatic first flavor: reuse the
existing Lima devshell VM (already aarch64-linux, already prx-managed) as the
remote builder — `nix build` lands the image in *its* store and
`nerdctl load` runs it in the *same* VM's containerd, so build and run colocate
with no host transfer. Today's bridge is the ad-hoc foreground
`nix run .#linux-builder`; prx-62h replaces it with prx-owned supervision. The
builder is general past Claude: once prx owns one, **all** pinned linux/OCI
artifacts (daemon images, future workcell images, cross-built release binaries)
build off it.

## Rejected alternatives

- **Keep the imperatively-provisioned Lima VM.** Rejected: no digest, mutable
  host, the agent↔daemon VM boundary forces the transport bridge. The whole
  point is content-addressing the runtime.
- **Closure-copy the nix store into the VM instead of building an image.**
  Rejected: a store closure is not an OCI artifact and gets no image digest, so
  it fails the "pinned, content-addressed" requirement — the digest is the
  deliverable.
- **One multi-tenant daemon pod for all repos.** Rejected:
  [[prx-beadsd-per-repo-no-multitenant]] — blast radius / confused-deputy. The
  pod is per-repo; cross-repo coordination is a sync agent (prx-697), not a
  shared daemon.
- **Solve isolation first (Kata/Firecracker) before shipping the container.**
  Rejected as sequencing: the image contract is independent of the isolation
  tier, so ship the rootless-podman runtime now and harden later (prx-5p5 /
  prx-n8d) without reshaping the images.

## Slices (the bead graph)

Epic **prx-zj8** (containerize the fleet) / epic **prx-d4o** (the Claude
runtime image). Suggested order — each builds on the prior and is independently
shippable:

1. **This ADR** (prx-d4o slice) — the spec. ✅ (this file)
2. **`prx-634` — `beadsd-box` image.** `dockerTools` image: `bd` + dolt client
   configured to connect to the external dolt. First image because beads is the
   least sensitive daemon (no signing key) and the door pattern is already
   proven by `bd-door-dialer.ts`. Validates the whole build path
   (dockerTools → linux builder → podman run) on the lowest-risk daemon.
3. **`prx-anj` — `keeperd-box` image.** The pinned aarch64-linux prx running
   `prx keeper serve`, with the signing key as a **runtime secret** (the
   care-about). Second because it carries the sensitive material and should land
   only once the build path is trusted.
4. **`dolt-box` image** (implicit in prx-zj8; cut a bead when 634 lands) — dolt
   from nixpkgs + the named-volume DB.
5. **`claude-box` image** (prx-d4o + prx-0wc) — claude-code + agent toolchain +
   pinned prx as the sole sanctioned tool surface; credential-free.
6. **`prx-asr` — assemble the pod + wire the doors.** Compose
   `{dolt-box, beadsd-box, keeperd-box}` long-running, `claude-box` joins the
   pod network → keeper/beads doors resolve to `localhost` (the payoff). The
   launcher `--keeper`/`--beads` flags ([[prx-mlj]]) attach the grants.
7. **Retire the Lima daemon-VM** (prx-zj8 acceptance) — make it optional, then
   remove `beadsd/provision.ts` + `lima-keeperd.ts` once the pod is the default.

**Dependency edges:** prx-634 and prx-anj both block prx-asr (can't assemble a
pod without its images); prx-62h (build substrate) blocks prx-634 (can't build a
linux image without a linux builder). Everything is downstream of a real Linux
build substrate existing.

## Open questions / risks

- **macOS linux-builder bootstrap** is the critical-path dependency (prx-62h);
  without it nothing in this epic builds. Resolve it first or in parallel.
- **State migration** from the existing VM dolt DB to a named volume — re-clone
  from the dolt remote is the clean path, but the watermark/sync story
  (prx-697) needs to hold across the move.
- **podman pod lifecycle ownership** — which prx actor owns
  pod-up/pod-down/health, mirroring how `lima/lifecycle.ts` owns the VM today.
  Likely a `prx pod` verb family; out of scope for the image slices, needed
  before prx-asr.
- **Isolation tier** stays source/lint-discipline until prx-5p5/prx-n8d land;
  STATUS claims must not overstate it ([[prx-claims-calibration-audit]]).
