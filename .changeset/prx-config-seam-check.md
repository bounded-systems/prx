---
---

prx-5yp: prx-config adopts @bounded-systems/seam-check for its extractability
test, replacing the hand-rolled allowlist + ambient harness with `assertSeam`
(prod: `zod`, `node:fs`; default ambient rules). Test-only; no change to the
published config parser.
