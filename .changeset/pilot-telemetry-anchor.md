---
"@bounded-systems/prx": minor
---

Anchor pilot telemetry into the signed `prx.pilot/v1` summary as an `observed: { digest, count }` field — a hash chain over all seam + leg-heartbeat observations, committed to by the pilot's existing signature. Tamper-evident with zero extra signatures, and never a gate (health stays off the authority chain). Slice 4 of the local-CI-in-the-pipeline work.
