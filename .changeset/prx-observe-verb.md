---
"@bounded-systems/prx": minor
---

Add `prx observe <unit>` — a read-only reader over the audit NDJSON that surfaces a work unit's pilot telemetry timeline (leg heartbeats + seam start/done events). The operator-facing surface for the pilot's `TELEMETRY_*` stream; complements `tail`/`jq` and `PRX_AUDIT_STDOUT=1`. Supports `--limit N` for the most recent events.
