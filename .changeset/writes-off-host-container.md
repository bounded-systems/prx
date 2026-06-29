---
"@bounded-systems/prx": minor
---

Move the residual bd config/schema WRITES off host bd (prx-82b Slice 2e.2): the
watermark + slack-watermark `bd config get/set` (`fetch/watermark.ts`,
`fetch/slack-watermark.ts`) and the bootstrap `schema_repair` op now default to an
ephemeral beadsd-box container runner (reusing `containerRepoRunner`; new
`containerBdSchemaRunner` for the `(args, cwd)` seam) instead of host bd —
per-repo-correct via the `/work` cwd bind. The host-bd primitives stay as the
injectable test seam. (A beadsd door config-verb is a later perf optimization for
the per-fetch-tick watermark path.)
