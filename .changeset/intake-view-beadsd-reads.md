---
"@bounded-systems/prx": patch
---

`prx plan view` and `prx intake view` now read beads through the beadsd daemon (the "one true source", GH-296) via a **targeted** `show <id>` rather than loading the whole set and filtering in JS — a single-id view asks the daemon for that one record, which is both cheaper and keeps provenance to `(query → result)` instead of the entire DB.

Also fixes a correctness bug in the daemon readers: the daemon returns raw `bd --json` (snake_case `external_ref`, `issue_type`, …), which was being cast straight to `BeadsRecord`. The snake→camel parse (`parseBeadsRecord` / `parseBeadsRecords`, extracted from `loadAllBeads`) is now applied host-side, so `externalRef` / `externalRefs` / `externalIssueNumber` are populated correctly.
