---
"@bounded-systems/prx": patch
---

Fix: `TELEMETRY_SEAM_OBSERVED` was emitted by the pilot's deterministic seams but never registered in `eventOwnerMap`, so `recordEvent` threw `unknown catalog event` and the best-effort sink wrapper silently swallowed it — seam telemetry never reached the audit log. Register it (owner `telemetry`) so the seam stream (intake/checks/ci/merge start/done) lands in the tailable audit NDJSON alongside the leg heartbeat, making a pilot run observable to operators.
