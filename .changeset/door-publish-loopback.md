---
"@bounded-systems/prx": patch
---

Bind published door ports to loopback (door-bridge ADR safety fix, prx-8uf2). `renderPodmanRun` published a secret room's `tcpPort` as `--publish <port>:<port>`, which binds `0.0.0.0` — an off-host credential leak, since these are credential doors (keeperd holds the git push token) and the TCP edge carries no authentication yet. The publish is now `127.0.0.1:<port>:<port>`: the host's own client keeps working (it dials localhost) while off-host callers are refused until the signed-grant bridge (phase 2) gates the edge.
