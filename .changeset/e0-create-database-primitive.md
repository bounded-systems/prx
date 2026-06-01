---
"@bounded-systems/prx": patch
---

dolt: add `createDoltDatabase` — an idempotent `CREATE DATABASE` primitive for the shared dolt sql-server (E0 of GH-1685). Probes `SHOW DATABASES` then creates the empty database when absent, reporting `created` / `exists` / `error`; re-validates the canonical reverse-DNS name before any SQL interpolation. Schema seeding (E1, `bd init --database`) and the `prx repo provision` verb (E4) compose it.
