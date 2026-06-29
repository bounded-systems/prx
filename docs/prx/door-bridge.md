# ADR — the door-bridge: authenticated TCP/vsock access to unix-only doors

> **Status: design.** Bead: **prx-8uf2**. Pairs with the door substrate
> (`src/door/transport.ts`, `framing.ts`), the credential doors (`ghappd`,
> keeperd), and the capability-transport model (claude-box ADR, prx-86g9:
> *authority chosen by `DoorTransport` — held-ref local, signed grant in transit*).

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
tcp/vsock edge — prx-8uf2). The daemon stays unix-only; the bridge is the *only*
TCP/vsock listener, and it **forwards to the unix socket only after authorizing
the caller**:

1. **Frame-transparent forward** — the bridge speaks the same length-prefixed
   framing (`door/framing.ts`); it does not parse door payloads, only gates them.
2. **Signed-grant gate** (non-loopback / cross-host) — the caller presents a
   grant: `{ door capability, holder identity, nbf, exp }` signed by the door
   **authority** (keymaker / the signer). The bridge verifies signature + window +
   that the capability matches this door, then forwards. No grant → refused
   before the unix socket is touched.
3. **vsock** for VM-isolated boxes (microVM / gVisor tiers) — same gate, vsock
   transport instead of TCP.

### Immediate safety fix (independent of the bridge)

`room/podman.ts` publishes `--publish ${port}:${port}` — i.e. `0.0.0.0`. Until the
grant-bridge exists, the published port must bind **loopback** (`127.0.0.1:${port}:${port}`)
so a credential door is never reachable off-host unauthenticated. (Today the port
forwards to nothing, but the binding should be correct before any bridge lands.)

## Phases

1. **Loopback bridge (opt-in, single-user/dev only).** A TCP→unix forwarder bound
   to `127.0.0.1`, behind an explicit opt-in flag, with a documented caveat: it
   widens door access from the socket's owner to *all local users* — acceptable on
   a single-user dev mac, **not** on a shared/prod host. Unblocks host-side leasing
   (e.g. the operator's `prx` dialing `PRX_GH_APP_DOOR=127.0.0.1:9998`).
2. **Signed-grant bridge (the real prx-8uf2).** The grant format + signer +
   in-bridge verification above. Enables multi-user hosts and cross-host/"movable"
   rooms safely. This is the gate that makes `--remote-control` / cross-host doors
   real (relates prx-9s14, authd/prx-6194).
3. **vsock transport** for VM-isolation tiers (prx-5p5 gVisor, prx-n8d Firecracker).

## Alternatives considered

- **Naive `socat` / unauthenticated bridge** — rejected: exposes a credential door.
- **Host-side bridge process** (not in-box) — viable, but the bead chose *uniform
  per-box* so every door image carries its own edge; keeps the room model honest
  (a door is reachable exactly where its box runs).
- **Tunnel via an existing mesh** (Tailscale, prx-9yv3) — complementary for
  network reachability, but does **not** replace the per-door grant gate (mesh
  authenticates the *host*, the grant authenticates the *capability*).

## Open

- **[DECISION] Grant issuer** — keymaker vs a dedicated door-authority signer; and
  whether grants are per-lease (short-lived, like the tokens) or per-session.
- **[DECISION] Loopback-bridge phase 1** — ship it as a dev convenience (with the
  multi-user caveat), or skip straight to signed grants? Recommend phase 1 gated
  behind an explicit opt-in, since most prx hosts are single-user dev machines.

Relates: capability-transport model (prx-86g9), DOORS.md / CAPABILITIES.md,
`src/door/transport.ts`, ghappd (prx-cdln) + keeperd, authd (prx-6194),
`--remote-control` (prx-9s14), host provisioning (prx-9yv3).
