---
"@bounded-systems/prx": patch
---

Drop the stranded drizzle tooling left behind by the `anchored-chain-sqlite` extraction: `drizzle.config.ts` (pointed at the removed `packages/anchored-chain-sqlite/`), the `db:generate`/`db:check` scripts, and the `drizzle-kit` devDependency. The schema → SQL → embed chain now lives entirely in `bounded-systems/anchored-chain-sqlite`. Internal tooling only — no CLI behavior change.
