---
"@bounded-systems/prx": patch
---

`withBeadsClient` now defaults to `resolveFramedTransport` instead of
hardcoding `unixSocketTransport`, so a `host:port`-shaped
`PRX_BEADS_SOCKET` value (the door-bridge, prx-8uf2) transparently gets a
TCP transport — needed because a macOS host cannot connect a unix socket
across the podman-machine virtiofs boundary
(`docs/prx/door-bridge.md`). Existing unix-socket-path callers are
unaffected: `resolveFramedTransport` dispatches to `unixSocketTransport` for
any endpoint string that isn't `host:port`-shaped, identical to today's
behavior.
