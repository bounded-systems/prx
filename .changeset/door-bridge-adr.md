---
"@bounded-systems/prx": patch
---

Add the door-bridge ADR (docs/prx/door-bridge.md, prx-8uf2): authenticated TCP/vsock access to the unix-only doors. Doors are in-pod-only today (verified: host TCP connect-then-closes, unix-over-virtiofs ENOENTs); the design is a per-box bridge that gates on a signed grant before forwarding to the unix socket (a naive socat would expose a credential door). Includes an immediate safety note (publish loopback, not 0.0.0.0) + phased plan (loopback dev convenience → signed-grant → vsock). Design only.
