---
---

Harden L3 verification: `verifyL3Attestation` now verifies the signature over
**canonical JSON** (recursively sorted keys, no whitespace) instead of
`JSON.stringify`, matching door-keeper's canonical signer — so verification is
independent of statement key order. Re-pins `keeperd-room` to the canonical-signing
door-keeper image (digest `eae893d5…`), landing the new image + the new verify
together. No release.
