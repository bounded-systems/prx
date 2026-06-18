---
---

Adopt Biome (format + lint) in warn/ratchet mode as the "shape & style" layer of
the self-checking toolchain, plus the `docs/agentic-code-hygiene.md` doctrine.
Remove 7 dead `eslint-disable` directives (no ESLint is installed). No-release
change: only tooling config, docs, tests, and a demo script changed — no
published package `src/` was touched.
