---
"@bounded-systems/prx": patch
---

`prx plan view` now reads beads through the beadsd daemon (the "one true source", GH-296 wave 1) instead of shelling out to a local `bd list --all`. The bd-record arm fails fast if beadsd is unreachable. Also fixes a latent TDZ in the `resolver ↔ intake-id` import cycle by making the `IntakeViewError` alias a live re-export.
