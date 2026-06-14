---
"@bounded-systems/prx": minor
---

Door transport gains a transport-agnostic dial (prx-o92 foundation). Add `tcpSocketTransport`, `parseDoorEndpoint`, and `resolveFramedTransport` to the shared transport module: a door endpoint string is dialed as a unix socket (`/run/keeperd.sock`, `unix://…`) or TCP (`host.containers.internal:3002`, `127.0.0.1:3128`, `tcp://…`) by one resolver, so a door client reaches a mounted socket OR a host-gateway / pod-local TCP port with no per-door code — closing the "dialed a `host:port` endpoint as a unix path" gap. Foundation only: adds the primitive; door clients adopt the resolver next.
