# ADR — the door-bridge: authenticated TCP/vsock access to unix-only doors

> **Status: partly implemented** (phases 0–1 + the keeper door-side gate of
> phase 2 are merged; see Phases). Bead: **prx-8uf2**. Pairs with the door
> substrate (`src/door/transport.ts`, `framing.ts`, `src/door/bridge.ts`), the
> credential doors (`ghappd`, keeperd: `src/keeperd/grant-gate.ts`), and the
> capability-transport model (claude-box ADR, prx-86g9: *authority chosen by
> `DoorTransport` — held-ref local, signed grant in transit*).

## Context

Every actor-door (ghappd / keeperd / beadsd) listens on a **unix socket** in the
shared door fabric (`/…/run/prx/doors/<door>.sock`). In-pod consumers reach it
container-to-container over that fabric — verified live: claude-room leased a
forge token through ghappd's unix socket.

`RoomSpec.tcpPort` makes the pod `--publish <port>:<port>`, but **nothing in the
box bridges TCP → the unix socket** — the daemon only binds the socket. So:

- Host/remote dials to `:9998`/`:9999` **connect-then-close** (no listener behind the port).
- unix-over-virtiofs **`ENOENT`s** from a macOS host (the socket file is visible but not connectable).

So doors are **in-pod-only** today. The gap is host and cross-host access.

**The hard constraint:** these are **credential** doors (ghappd leases GitHub App
tokens; keeperd performs git writes). Exposing one on a non-loopback interface
*without authentication* is a credential-leak hole — anyone who can reach the port
can lease. A naive `socat TCP→unix` is therefore **unacceptable**.

## Trust tiers (what authenticates what)

| caller | path today | authority |
|---|---|---|
| **in-pod** (sibling container) | shared unix fabric | the pod boundary (trusted); held-ref, no grant |
| **same-host** (host process → pod) | — (gap) | local; the unix socket is FS-perm-gated (owner). A loopback TCP bridge widens to *all local users* |
| **cross-host / remote** | — (gap) | **untrusted network → must present a signed grant** |

The capability-transport model already names this split: `DoorTransport` chooses
the authority — a **held reference** for local/in-pod, a **signed grant** in
transit. The bridge is where "in transit" gets enforced.

## Decision

A **per-box door-bridge** (the box always speaks unix; the bridge owns the
tcp/vsock edge — prx-8uf2). Two cooperating parts:

1. **Frame-transparent forward** — the bridge is a TCP/vsock listener that pumps
   bytes to the door's unix socket. It does **not** parse door payloads or gate
   them; it is pure reachability. Bound to **loopback** so an unauthenticated edge
   is never reachable off-host. Built: `src/door/bridge.ts` + `prx door bridge`.
2. **Signed-grant gate — AT THE DOOR, not in the bridge.** The caller presents a
   grant inside its request envelope (`RequestEnvelope.grant`); the **door
   daemon** verifies it before dispatch via guest-room's `signedGrantAuthorizer`
   (audience + door + exp + issuer-key, over the request). On a **unix** socket
   the kernel authenticates the peer, so the held reference is the authority (no
   grant); on a **tcp/vsock** edge a reachable socket is not authority, so a valid
   grant is required. Built for keeperd: `src/keeperd/grant-gate.ts`.
3. **vsock** for VM-isolated boxes (microVM / gVisor tiers) — same door-side gate,
   vsock transport instead of TCP.

> **Correction (2026-06-29).** This ADR's first draft put the signed-grant gate
> *inside the forwarding bridge*. That is wrong: the gate is a door-side
> `RequestAuthorizer` over the request envelope's `grant` (already built +
> e2e-verified in guest-room `signedGrantAuthorizer`, #38/#40, published in
> `@bounded-systems/guest-room` **0.3.0+**). A byte-forwarding bridge *cannot*
> gate without parsing the door protocol — which it must not do. So the bridge
> stays transparent (reachability + loopback safety) and **the door authorizes**.
> A bridge-level gate would also double-gate and split the authority model.

### Immediate safety fix (independent of the bridge) — DONE (#827)

`room/podman.ts` published `--publish ${port}:${port}` — i.e. `0.0.0.0`. It now
binds **loopback** (`127.0.0.1:${port}:${port}`) so a credential door is never
reachable off-host unauthenticated, independent of (and prerequisite to) the gate.

## Phases

0. **Publish-side safety fix — DONE (#827).** `room/podman.ts` published a
   credential door's `tcpPort` as `--publish PORT:PORT` (`0.0.0.0`). Now
   `127.0.0.1:PORT:PORT` — never reachable off-host unauthenticated.
1. **Loopback bridge — DONE (#830).** `prx door bridge` = a `127.0.0.1`-only
   TCP→unix forwarder (`src/door/bridge.ts`), frame-transparent, explicit opt-in,
   loud dev-only caveat (widens to all local users). Unblocks host-side leasing.
2. **Door-side signed-grant gate — keeper DONE (this PR).** keeperd installs
   guest-room's `signedGrantAuthorizer` on its **TCP** edge (unix bypasses —
   held-ref): a TCP request must carry a valid grant (audience + `keeper` door +
   exp + issuer key). Config-gated by `KEEPERD_GRANT_AUDIENCE` +
   `KEEPERD_ISSUER_KEYS`; unconfigured TCP stays unauthenticated-but-loopback and
   WARNs loudly. Needed the `@bounded-systems/guest-room` **0.2.0 → 0.4.0** bump
   (0.2.0 predates the grant primitives). *Remaining:* the same gate for ghappd
   (its own framing, not yet on the guest-room protocol), and **grant acquisition**
   (concierge `resolve()` + refresh-before-TTL) — deployment-coupled, prx-9s14.
3. **vsock transport** for VM-isolation tiers (prx-5p5 gVisor, prx-n8d Firecracker).

## Alternatives considered

- **Naive `socat` / unauthenticated bridge** — rejected: exposes a credential door.
- **Host-side bridge process** (not in-box) — viable, but the bead chose *uniform
  per-box* so every door image carries its own edge; keeps the room model honest
  (a door is reachable exactly where its box runs).
- **Tunnel via an existing mesh** (Tailscale, prx-9yv3) — complementary for
  network reachability, but does **not** replace the per-door grant gate (mesh
  authenticates the *host*, the grant authenticates the *capability*).

## Decisions settled (2026-06-29)

- **Grant issuer** — reuse the published-issuer-key model guest-room already
  ships (`IssuerKeys` = `{ kid, publicKeyPem }[]`, keyless verification), keyed to
  prx's keymaker/provenance per-actor identities. Grants are **per-lease**
  (short-lived, mirroring the ghappd token TTL), not per-session.
- **Loopback bridge phase 1** — shipped, behind an explicit opt-in (`prx door
  bridge`), with the multi-user caveat, since most prx hosts are single-user dev
  machines.

## Open

- **Grant acquisition** — how a legit client obtains + presents a grant
  (concierge `resolve()` + refresh-before-TTL, where the issuer keys are
  published). Deployment-coupled — tracked with prx-9s14.
- **ghappd parity** — ghappd uses its own framing, not the guest-room door
  protocol; converging it is the prerequisite to gating its TCP edge the same way.

Relates: capability-transport model (prx-86g9), DOORS.md / CAPABILITIES.md,
`src/door/transport.ts`, ghappd (prx-cdln) + keeperd, authd (prx-6194),
`--remote-control` (prx-9s14), host provisioning (prx-9yv3).
