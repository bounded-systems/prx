---
---

Harden the agentic-hygiene doctrine with its own forcing function: a meta-test
(`test/architecture/self-check-layers.test.ts`) that fails if any of the eight
self-check layers loses its on-disk gate, or if `docs/agentic-code-hygiene.md`
stops documenting a layer the test enforces — so the doctrine can't out-run the
code, and a self-check layer can't be silently removed. Test-only; no behavior
change, no package release.
